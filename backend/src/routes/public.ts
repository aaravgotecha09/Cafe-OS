import { Router } from "express";
import { z } from "zod";
import { and, asc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { db, schema as s } from "../db";
import { ah, ok, parse } from "../utils/http";
import { bad, notFound } from "../utils/errors";
import { notify } from "../services/notify";

export const publicRouter = Router();

async function restBySlug(slug: unknown) {
  const [r] = await db.select().from(s.restaurants).where(eq(s.restaurants.slug, String(slug || "")));
  if (!r) throw notFound("Restaurant not found");
  return r;
}
export async function loadMenu(rid: string, includeUnavailable = false) {
  const cats = await db.select().from(s.categories).where(and(eq(s.categories.restaurantId, rid), eq(s.categories.active, true))).orderBy(asc(s.categories.sortOrder));
  const prods = await db.select().from(s.products).where(and(eq(s.products.restaurantId, rid), ...(includeUnavailable ? [] : [eq(s.products.available, true)]))).orderBy(asc(s.products.name));
  const ids = prods.map((p) => p.id);
  const variants = ids.length ? await db.select().from(s.productVariants).where(inArray(s.productVariants.productId, ids)) : [];
  const groups = ids.length ? await db.select().from(s.customizationGroups).where(inArray(s.customizationGroups.productId, ids)) : [];
  const options = groups.length ? await db.select().from(s.customizationOptions).where(inArray(s.customizationOptions.groupId, groups.map((g) => g.id))) : [];
  return {
    categories: cats,
    products: prods.map((p) => ({ ...p, variants: variants.filter((v) => v.productId === p.id), customizationGroups: groups.filter((g) => g.productId === p.id).map((g) => ({ ...g, options: options.filter((o) => o.groupId === g.id) })) })),
  };
}
publicRouter.get("/restaurant/:slug", ah(async (req, res) => {
  const r = await restBySlug(req.params.slug);
  ok(res, { id: r.id, name: r.name, slug: r.slug, logoUrl: r.logoUrl, address: r.address, phone: r.phone, currency: r.currency, hours: (r.settings as any)?.hours ?? null });
}));
publicRouter.get("/menu", ah(async (req, res) => {
  const r = await restBySlug(req.query.restaurant);
  const m = await loadMenu(r.id);
  const q = String(req.query.q || "").toLowerCase(); const diet = String(req.query.diet || ""); const cat = String(req.query.category || "");
  let products = m.products;
  if (q) products = products.filter((p) => (p.name + " " + p.description + " " + p.ingredients.join(" ")).toLowerCase().includes(q));
  if (diet === "veg") products = products.filter((p) => p.diet === "VEG"); if (diet === "vegan") products = products.filter((p) => p.vegan); if (diet === "jain") products = products.filter((p) => p.jain); if (diet === "nonveg") products = products.filter((p) => p.diet === "NON_VEG");
  if (cat) { const c = m.categories.find((x) => x.slug === cat); products = c ? products.filter((p) => p.categoryId === c.id) : []; }
  ok(res, { categories: m.categories, products });
}));
publicRouter.get("/menu/product/:slug", ah(async (req, res) => {
  const r = await restBySlug(req.query.restaurant);
  const p = (await loadMenu(r.id, true)).products.find((x) => x.slug === req.params.slug);
  if (!p) throw notFound("Product not found"); ok(res, p);
}));

// ---- reservations (public) ----
const SLOT_START = 11, SLOT_END = 21; // café hours 11:00–21:00 IST (configurable via settings.hours later)
const istDate = (date: string, h: number, m: number) => new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+05:30`);
async function freeTable(rid: string, start: Date, dur: number, party: number) {
  const tables = await db.select().from(s.cafeTables).where(and(eq(s.cafeTables.restaurantId, rid), gte(s.cafeTables.capacity, party))).orderBy(asc(s.cafeTables.capacity), asc(s.cafeTables.number));
  const end = new Date(start.getTime() + dur * 60000);
  const day = await db.select().from(s.reservations).where(and(eq(s.reservations.restaurantId, rid), ne(s.reservations.status, "CANCELLED"), lt(s.reservations.startsAt, end), gte(s.reservations.startsAt, new Date(start.getTime() - 6 * 3600000))));
  const busy = new Set(day.filter((r) => r.tableId && new Date(r.startsAt.getTime() + r.durationMin * 60000) > start).map((r) => r.tableId));
  return tables.find((t) => !busy.has(t.id));
}
publicRouter.get("/reservations/slots", ah(async (req, res) => {
  const r = await restBySlug(req.query.restaurant);
  const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), party: z.coerce.number().int().min(1).max(20) }), req.query);
  const slots: { time: string; available: boolean }[] = [];
  for (let h = SLOT_START; h < SLOT_END; h++) for (const m of [0, 30]) {
    const start = istDate(q.date, h, m);
    slots.push({ time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, available: start > new Date() && !!(await freeTable(r.id, start, 90, q.party)) });
  }
  ok(res, slots);
}));
publicRouter.post("/reservations", ah(async (req, res) => {
  const r = await restBySlug(req.query.restaurant);
  const b = parse(z.object({ name: z.string().min(1).max(60), phone: z.string().regex(/^\+?[0-9]{10,13}$/), email: z.string().email().optional(), partySize: z.number().int().min(1).max(20), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) }), req.body);
  const start = new Date(`${b.date}T${b.time}:00+05:30`);
  if (isNaN(+start) || start <= new Date()) throw bad("Choose a future time");
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"resv:" + r.id}))`);
    const t = await freeTable(r.id, start, 90, b.partySize);
    if (!t) return null;
    const [row] = await tx.insert(s.reservations).values({ restaurantId: r.id, tableId: t.id, name: b.name, phone: b.phone, email: b.email, partySize: b.partySize, startsAt: start }).returning();
    return row;
  });
  if (!created) throw bad("No table available at that time — try another slot or join the waitlist");
  await notify(r.id, { role: "MANAGER", title: "New reservation", body: `${b.name}, party of ${b.partySize}, ${b.date} ${b.time}`, kind: "reservation" });
  ok(res, created, 201);
}));
publicRouter.post("/reservations/:id/cancel", ah(async (req, res) => {
  const b = parse(z.object({ phone: z.string() }), req.body);
  const [r] = await db.update(s.reservations).set({ status: "CANCELLED" }).where(and(eq(s.reservations.id, String(req.params.id)), eq(s.reservations.phone, b.phone), ne(s.reservations.status, "CANCELLED"))).returning();
  if (!r) throw notFound("Reservation not found"); ok(res, r);
}));
publicRouter.post("/waitlist", ah(async (req, res) => {
  const r = await restBySlug(req.query.restaurant);
  const b = parse(z.object({ name: z.string().min(1).max(60), phone: z.string().regex(/^\+?[0-9]{10,13}$/).optional(), partySize: z.number().int().min(1).max(20) }), req.body);
  const [w] = await db.insert(s.waitlist).values({ restaurantId: r.id, ...b }).returning();
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(s.waitlist).where(and(eq(s.waitlist.restaurantId, r.id), eq(s.waitlist.status, "WAITING")));
  await notify(r.id, { role: "WAITER", title: "Waitlist", body: `${b.name} (${b.partySize})`, kind: "waitlist" });
  ok(res, { ...w, position: Number(n), estimatedWaitMinutes: Number(n) * 10 }, 201);
}));
publicRouter.get("/waitlist/:id", ah(async (req, res) => {
  const [w] = await db.select().from(s.waitlist).where(eq(s.waitlist.id, String(req.params.id)));
  if (!w) throw notFound("Not found");
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(s.waitlist).where(and(eq(s.waitlist.restaurantId, w.restaurantId), eq(s.waitlist.status, "WAITING"), lt(s.waitlist.createdAt, w.createdAt)));
  ok(res, { id: w.id, status: w.status, position: w.status === "WAITING" ? Number(n) + 1 : 0, estimatedWaitMinutes: w.status === "WAITING" ? (Number(n) + 1) * 10 : 0 });
}));
