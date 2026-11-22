import { Router } from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db, schema as s } from "../db";
import { ah, ok, paging, parse } from "../utils/http";
import { bad, conflict, forbidden, notFound } from "../utils/errors";
import { ROLES, requireStaff } from "../middleware/auth";
import { hashPassword, randomToken, signQr } from "../utils/crypto";
import { audit } from "../services/notify";
import { adjustStock } from "../services/inventory";
import { refundPayment } from "../services/billing";
import { env } from "../config/env";
import { emitTo, rooms } from "../sockets";
import { loadMenu } from "./public";

export const adminRouter = Router();
const mgmt = requireStaff(...ROLES.MGMT);
const owner = requireStaff(...ROLES.ADMIN);
const slugify = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const csv = (res: any, name: string, data: any[]) => {
  const cols = data.length ? Object.keys(data[0]) : [];
  const esc = (v: any) => { let t = v instanceof Date ? v.toISOString() : String(v ?? ""); if (/^[=+\-@]/.test(t)) t = "'" + t; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  res.type("text/csv").attachment(`${name}.csv`).send([cols.join(","), ...data.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));
};
const out = (req: any, res: any, name: string, data: any[]) => (req.query.format === "csv" ? csv(res, name, data) : ok(res, data));

// ---------- menu ----------
adminRouter.get("/menu", mgmt, ah(async (req, res) => ok(res, await loadMenu(req.staff!.rid, true))));
const productBody = z.object({
  categoryId: z.string().uuid(), stationId: z.string().uuid().nullable().optional(), name: z.string().min(1).max(100), description: z.string().max(1000).default(""), imageUrl: z.string().max(500).nullable().optional(),
  price: z.number().int().min(0), discountPrice: z.number().int().min(0).nullable().optional(), diet: z.enum(["VEG", "NON_VEG", "EGG"]).default("VEG"), vegan: z.boolean().default(false), jain: z.boolean().default(false),
  spiceLevel: z.number().int().min(0).max(5).default(0), portion: z.string().max(40).nullable().optional(), prepMinutes: z.number().int().min(1).max(180).default(10), calories: z.number().int().min(0).nullable().optional(),
  allergens: z.array(z.string()).default([]), ingredients: z.array(z.string()).default([]), available: z.boolean().default(true), tags: z.array(z.string()).default([]),
  variants: z.array(z.object({ name: z.string(), priceDelta: z.number().int().default(0), isDefault: z.boolean().default(false) })).default([]),
  customizationGroups: z.array(z.object({ name: z.string(), required: z.boolean().default(false), multi: z.boolean().default(false), maxSelect: z.number().int().nullable().optional(), options: z.array(z.object({ name: z.string(), priceDelta: z.number().int().default(0) })).min(1) })).default([]),
});
async function saveNested(tx: any, pid: string, b: z.infer<typeof productBody>) {
  await tx.delete(s.productVariants).where(eq(s.productVariants.productId, pid)); await tx.delete(s.customizationGroups).where(eq(s.customizationGroups.productId, pid));
  if (b.variants.length) await tx.insert(s.productVariants).values(b.variants.map((v) => ({ ...v, productId: pid })));
  for (const g of b.customizationGroups) { const [gr] = await tx.insert(s.customizationGroups).values({ productId: pid, name: g.name, required: g.required, multi: g.multi, maxSelect: g.maxSelect ?? null }).returning(); await tx.insert(s.customizationOptions).values(g.options.map((o) => ({ ...o, groupId: gr.id }))); }
}
async function checkRefs(rid: string, b: z.infer<typeof productBody>) {
  const [c] = await db.select().from(s.categories).where(and(eq(s.categories.id, b.categoryId), eq(s.categories.restaurantId, rid))); if (!c) throw bad("Invalid category");
  if (b.stationId) { const [st] = await db.select().from(s.kitchenStations).where(and(eq(s.kitchenStations.id, b.stationId), eq(s.kitchenStations.restaurantId, rid))); if (!st) throw bad("Invalid station"); }
  if (b.discountPrice != null && b.discountPrice > b.price) throw bad("Discount price cannot exceed price");
}
adminRouter.post("/products", mgmt, ah(async (req, res) => {
  const b = parse(productBody, req.body); await checkRefs(req.staff!.rid, b);
  const { variants, customizationGroups, ...p } = b;
  const created = await db.transaction(async (tx) => { const [row] = await tx.insert(s.products).values({ ...p, restaurantId: req.staff!.rid, slug: slugify(p.name) + "-" + randomToken(2) }).returning(); await saveNested(tx, row.id, b); return row; });
  await audit(req.staff!.rid, req.staff!.id, "product.create", "product", created.id); ok(res, created, 201);
}));
adminRouter.put("/products/:id", mgmt, ah(async (req, res) => {
  const b = parse(productBody, req.body); await checkRefs(req.staff!.rid, b);
  const { variants, customizationGroups, ...p } = b;
  const row = await db.transaction(async (tx) => { const [r] = await tx.update(s.products).set({ ...p, autoUnavailable: false }).where(and(eq(s.products.id, String(req.params.id)), eq(s.products.restaurantId, req.staff!.rid))).returning(); if (!r) throw notFound("Product not found"); await saveNested(tx, r.id, b); return r; });
  await audit(req.staff!.rid, req.staff!.id, "product.update", "product", row.id); ok(res, row);
}));
adminRouter.patch("/products/:id", mgmt, ah(async (req, res) => {
  const b = parse(z.object({ available: z.boolean().optional(), price: z.number().int().min(0).optional(), discountPrice: z.number().int().min(0).nullable().optional(), stationId: z.string().uuid().nullable().optional(), prepMinutes: z.number().int().min(1).optional() }), req.body);
  const [r] = await db.update(s.products).set({ ...b, ...(b.available !== undefined ? { autoUnavailable: false } : {}) }).where(and(eq(s.products.id, String(req.params.id)), eq(s.products.restaurantId, req.staff!.rid))).returning();
  if (!r) throw notFound("Product not found"); await audit(req.staff!.rid, req.staff!.id, "product.patch", "product", r.id, b); ok(res, r);
}));
adminRouter.delete("/products/:id", mgmt, ah(async (req, res) => {
  const used = await db.select({ id: s.orderItems.id }).from(s.orderItems).where(eq(s.orderItems.productId, String(req.params.id))).limit(1);
  if (used.length) { await db.update(s.products).set({ available: false }).where(and(eq(s.products.id, String(req.params.id)), eq(s.products.restaurantId, req.staff!.rid))); return ok(res, { deleted: false, disabled: true, reason: "Product has order history; it was disabled instead" }); }
  const r = await db.delete(s.products).where(and(eq(s.products.id, String(req.params.id)), eq(s.products.restaurantId, req.staff!.rid))).returning(); if (!r.length) throw notFound("Product not found");
  await audit(req.staff!.rid, req.staff!.id, "product.delete", "product", String(req.params.id)); ok(res, { deleted: true });
}));
adminRouter.put("/products/:id/recipe", mgmt, ah(async (req, res) => {
  const b = parse(z.object({ ingredients: z.array(z.object({ inventoryItemId: z.string().uuid(), quantity: z.number().positive() })) }), req.body);
  const [p] = await db.select().from(s.products).where(and(eq(s.products.id, String(req.params.id)), eq(s.products.restaurantId, req.staff!.rid))); if (!p) throw notFound("Product not found");
  await db.transaction(async (tx) => { await tx.delete(s.recipeIngredients).where(eq(s.recipeIngredients.productId, p.id)); if (b.ingredients.length) await tx.insert(s.recipeIngredients).values(b.ingredients.map((i) => ({ productId: p.id, inventoryItemId: i.inventoryItemId, quantity: String(i.quantity) }))); });
  ok(res, { saved: b.ingredients.length });
}));
adminRouter.get("/products/:id/recipe", mgmt, ah(async (req, res) => ok(res, await db.select({ inventoryItemId: s.recipeIngredients.inventoryItemId, quantity: s.recipeIngredients.quantity, name: s.inventoryItems.name, unit: s.inventoryItems.unit }).from(s.recipeIngredients).innerJoin(s.inventoryItems, eq(s.inventoryItems.id, s.recipeIngredients.inventoryItemId)).where(eq(s.recipeIngredients.productId, String(req.params.id))))));

adminRouter.get("/categories", mgmt, ah(async (req, res) => ok(res, await db.select().from(s.categories).where(eq(s.categories.restaurantId, req.staff!.rid)).orderBy(asc(s.categories.sortOrder)))));
adminRouter.post("/categories", mgmt, ah(async (req, res) => { const b = parse(z.object({ name: z.string().min(1), sortOrder: z.number().int().default(0), active: z.boolean().default(true) }), req.body); const [c] = await db.insert(s.categories).values({ ...b, restaurantId: req.staff!.rid, slug: slugify(b.name) }).returning(); ok(res, c, 201); }));
adminRouter.put("/categories/:id", mgmt, ah(async (req, res) => { const b = parse(z.object({ name: z.string().min(1), sortOrder: z.number().int(), active: z.boolean() }), req.body); const [c] = await db.update(s.categories).set({ ...b, slug: slugify(b.name) }).where(and(eq(s.categories.id, String(req.params.id)), eq(s.categories.restaurantId, req.staff!.rid))).returning(); if (!c) throw notFound("Category not found"); ok(res, c); }));
adminRouter.delete("/categories/:id", mgmt, ah(async (req, res) => { const [p] = await db.select({ id: s.products.id }).from(s.products).where(eq(s.products.categoryId, String(req.params.id))).limit(1); if (p) throw conflict("Category still has products"); const r = await db.delete(s.categories).where(and(eq(s.categories.id, String(req.params.id)), eq(s.categories.restaurantId, req.staff!.rid))).returning(); if (!r.length) throw notFound("Category not found"); ok(res, { deleted: true }); }));
adminRouter.post("/stations", mgmt, ah(async (req, res) => { const b = parse(z.object({ name: z.string().min(1), code: z.string().min(1).max(12) }), req.body); const [r] = await db.insert(s.kitchenStations).values({ ...b, code: b.code.toUpperCase(), restaurantId: req.staff!.rid }).returning(); ok(res, r, 201); }));
adminRouter.delete("/stations/:id", mgmt, ah(async (req, res) => { const r = await db.delete(s.kitchenStations).where(and(eq(s.kitchenStations.id, String(req.params.id)), eq(s.kitchenStations.restaurantId, req.staff!.rid))).returning(); if (!r.length) throw notFound("Station not found"); ok(res, { deleted: true }); }));

adminRouter.post("/uploads", mgmt, ah(async (req, res) => {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) return res.status(501).json({ success: false, error: { code: "NOT_CONFIGURED", message: "Image upload is not configured (Cloudinary env vars missing). Paste an image URL instead." } });
  const b = parse(z.object({ dataUrl: z.string().regex(/^data:image\/(png|jpe?g|webp);base64,/).max(7_000_000) }), req.body);
  const ts = Math.floor(Date.now() / 1000); const folder = `cafe-os/${req.staff!.rid}`;
  const signature = crypto.createHash("sha1").update(`folder=${folder}&timestamp=${ts}${env.CLOUDINARY_API_SECRET}`).digest("hex");
  const form = new URLSearchParams({ file: b.dataUrl, api_key: env.CLOUDINARY_API_KEY, timestamp: String(ts), folder, signature });
  const r = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: form });
  const j: any = await r.json(); if (!r.ok) throw bad(j?.error?.message || "Upload failed"); ok(res, { url: j.secure_url });
}));

// ---------- tables & QR ----------
const tableUrl = (t: typeof s.cafeTables.$inferSelect) => { const token = signQr({ r: t.restaurantId, t: t.id, n: t.qrNonce }); return { token, url: `${env.FRONTEND_URL}/table/${token}` }; };
adminRouter.get("/tables", mgmt, ah(async (req, res) => {
  const tables = await db.select().from(s.cafeTables).where(eq(s.cafeTables.restaurantId, req.staff!.rid)).orderBy(asc(s.cafeTables.number));
  const sess = await db.select().from(s.tableSessions).where(and(eq(s.tableSessions.restaurantId, req.staff!.rid), isNull(s.tableSessions.closedAt)));
  ok(res, tables.map((t) => ({ ...t, qrNonce: undefined, activeSession: sess.find((x) => x.tableId === t.id) ?? null })));
}));
const tableBody = z.object({ number: z.number().int().min(1), capacity: z.number().int().min(1).max(30).default(4), location: z.string().max(60).default("Main hall"), posX: z.number().int().default(0), posY: z.number().int().default(0) });
adminRouter.post("/tables", mgmt, ah(async (req, res) => { const b = parse(tableBody, req.body); const [t] = await db.insert(s.cafeTables).values({ ...b, restaurantId: req.staff!.rid }).returning(); ok(res, t, 201); }));
adminRouter.put("/tables/:id", mgmt, ah(async (req, res) => { const b = parse(tableBody.partial(), req.body); const [t] = await db.update(s.cafeTables).set(b).where(and(eq(s.cafeTables.id, String(req.params.id)), eq(s.cafeTables.restaurantId, req.staff!.rid))).returning(); if (!t) throw notFound("Table not found"); emitTo(rooms.staff(t.restaurantId), "table:status_updated", { tableId: t.id, layout: true }); ok(res, t); }));
adminRouter.put("/tables-layout", mgmt, ah(async (req, res) => {
  const b = parse(z.object({ tables: z.array(z.object({ id: z.string().uuid(), posX: z.number().int(), posY: z.number().int() })) }), req.body);
  await db.transaction(async (tx) => { for (const t of b.tables) await tx.update(s.cafeTables).set({ posX: t.posX, posY: t.posY }).where(and(eq(s.cafeTables.id, t.id), eq(s.cafeTables.restaurantId, req.staff!.rid))); });
  emitTo(rooms.staff(req.staff!.rid), "table:status_updated", { layout: true }); ok(res, { saved: b.tables.length });
}));
adminRouter.delete("/tables/:id", mgmt, ah(async (req, res) => { const [live] = await db.select().from(s.tableSessions).where(and(eq(s.tableSessions.tableId, String(req.params.id)), isNull(s.tableSessions.closedAt))); if (live) throw conflict("Table has an active session"); try { const r = await db.delete(s.cafeTables).where(and(eq(s.cafeTables.id, String(req.params.id)), eq(s.cafeTables.restaurantId, req.staff!.rid))).returning(); if (!r.length) throw notFound("Table not found"); } catch (e: any) { if (e.code === "23503") throw conflict("Table has order history and cannot be deleted"); throw e; } ok(res, { deleted: true }); }));
adminRouter.get("/qr-codes", mgmt, ah(async (req, res) => {
  const tables = await db.select().from(s.cafeTables).where(eq(s.cafeTables.restaurantId, req.staff!.rid)).orderBy(asc(s.cafeTables.number));
  ok(res, await Promise.all(tables.map(async (t) => { const q = tableUrl(t); return { tableId: t.id, number: t.number, url: q.url, png: await QRCode.toDataURL(q.url, { margin: 1, width: 480, color: { dark: "#1C1917", light: "#FFFFFF" } }) }; })));
}));
adminRouter.post("/tables/:id/rotate-qr", mgmt, ah(async (req, res) => { const [t] = await db.update(s.cafeTables).set({ qrNonce: randomToken(8) }).where(and(eq(s.cafeTables.id, String(req.params.id)), eq(s.cafeTables.restaurantId, req.staff!.rid))).returning(); if (!t) throw notFound("Table not found"); await audit(req.staff!.rid, req.staff!.id, "table.rotate_qr", "table", t.id); ok(res, { url: tableUrl(t).url }); }));

// ---------- staff ----------
const staffBody = z.object({ name: z.string().min(1).max(60), email: z.string().email(), password: z.string().min(8).max(100).optional(), role: z.enum(["MANAGER", "WAITER", "KITCHEN_STAFF", "CASHIER", "RESTAURANT_OWNER"]), station: z.string().nullable().optional(), section: z.string().nullable().optional(), active: z.boolean().optional(), available: z.boolean().optional() });
const canGrant = (actor: string, role: string) => actor === "SUPER_ADMIN" || actor === "RESTAURANT_OWNER" ? true : ["WAITER", "KITCHEN_STAFF", "CASHIER"].includes(role);
adminRouter.get("/staff", mgmt, ah(async (req, res) => {
  const list = await db.select({ id: s.users.id, name: s.users.name, email: s.users.email, role: s.users.role, station: s.users.station, section: s.users.section, active: s.users.active, available: s.users.available }).from(s.users).where(eq(s.users.restaurantId, req.staff!.rid)).orderBy(asc(s.users.name));
  const perf = await rows(sql`select assigned_to as id, count(*)::int as handled, coalesce(round(avg(extract(epoch from (completed_at - created_at))/60)::numeric,1),0)::float as avg_minutes from service_requests where restaurant_id=${req.staff!.rid} and status='COMPLETED' group by assigned_to`);
  const ords = await rows(sql`select assigned_staff_id as id, count(*)::int as orders from orders where restaurant_id=${req.staff!.rid} and assigned_staff_id is not null group by assigned_staff_id`);
  ok(res, list.map((u) => ({ ...u, requestsCompleted: perf.find((p) => p.id === u.id)?.handled ?? 0, avgRequestMinutes: perf.find((p) => p.id === u.id)?.avg_minutes ?? 0, ordersHandled: ords.find((p) => p.id === u.id)?.orders ?? 0 })));
}));
adminRouter.post("/staff", mgmt, ah(async (req, res) => {
  const b = parse(staffBody.required({ password: true }), req.body);
  if (!canGrant(req.staff!.role, b.role)) throw forbidden("You cannot create this role");
  const [u] = await db.insert(s.users).values({ restaurantId: req.staff!.rid, email: b.email.toLowerCase(), passwordHash: await hashPassword(b.password), name: b.name, role: b.role, station: b.station, section: b.section }).returning();
  await audit(req.staff!.rid, req.staff!.id, "staff.create", "user", u.id, { role: b.role }); ok(res, { id: u.id, email: u.email, role: u.role }, 201);
}));
adminRouter.put("/staff/:id", mgmt, ah(async (req, res) => {
  const b = parse(staffBody.partial(), req.body);
  const [t] = await db.select().from(s.users).where(and(eq(s.users.id, String(req.params.id)), eq(s.users.restaurantId, req.staff!.rid))); if (!t) throw notFound("Staff not found");
  if (!canGrant(req.staff!.role, t.role) || (b.role && !canGrant(req.staff!.role, b.role))) throw forbidden("You cannot modify this role");
  const { password, ...rest } = b; const upd: any = { ...rest, ...(rest.email ? { email: rest.email.toLowerCase() } : {}) }; if (password) upd.passwordHash = await hashPassword(password);
  const [u] = await db.update(s.users).set(upd).where(eq(s.users.id, t.id)).returning(); await audit(req.staff!.rid, req.staff!.id, "staff.update", "user", u.id, { fields: Object.keys(b) }); ok(res, { id: u.id });
}));
adminRouter.delete("/staff/:id", mgmt, ah(async (req, res) => {
  if (String(req.params.id) === req.staff!.id) throw bad("You cannot delete yourself");
  const [t] = await db.select().from(s.users).where(and(eq(s.users.id, String(req.params.id)), eq(s.users.restaurantId, req.staff!.rid))); if (!t) throw notFound("Staff not found");
  if (!canGrant(req.staff!.role, t.role)) throw forbidden("You cannot delete this role");
  await db.delete(s.users).where(eq(s.users.id, t.id)); await audit(req.staff!.rid, req.staff!.id, "staff.delete", "user", t.id); ok(res, { deleted: true });
}));
adminRouter.get("/shifts", mgmt, ah(async (req, res) => ok(res, await db.select({ s: s.shifts, name: s.users.name, role: s.users.role }).from(s.shifts).innerJoin(s.users, eq(s.users.id, s.shifts.userId)).where(eq(s.shifts.restaurantId, req.staff!.rid)).orderBy(desc(s.shifts.startsAt)).limit(200))));
adminRouter.post("/shifts", mgmt, ah(async (req, res) => {
  const b = parse(z.object({ userId: z.string().uuid(), startsAt: z.string().datetime(), endsAt: z.string().datetime() }), req.body);
  if (new Date(b.endsAt) <= new Date(b.startsAt)) throw bad("Shift must end after it starts");
  const [u] = await db.select().from(s.users).where(and(eq(s.users.id, b.userId), eq(s.users.restaurantId, req.staff!.rid))); if (!u) throw bad("Staff not found");
  const [r] = await db.insert(s.shifts).values({ restaurantId: req.staff!.rid, userId: b.userId, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt) }).returning(); ok(res, r, 201);
}));
adminRouter.post("/shifts/:id/:action", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => {
  const act = z.enum(["check-in", "check-out"]).parse(req.params.action);
  const [sh] = await db.select().from(s.shifts).where(and(eq(s.shifts.id, String(req.params.id)), eq(s.shifts.restaurantId, req.staff!.rid))); if (!sh) throw notFound("Shift not found");
  if (sh.userId !== req.staff!.id && !ROLES.MGMT.includes(req.staff!.role)) throw forbidden();
  const [r] = await db.update(s.shifts).set(act === "check-in" ? { checkedInAt: new Date() } : { checkedOutAt: new Date() }).where(eq(s.shifts.id, sh.id)).returning(); ok(res, r);
}));

// ---------- inventory ----------
const invBody = z.object({ name: z.string().min(1), unit: z.string().min(1), quantity: z.number().min(0).default(0), minStock: z.number().min(0).default(0), supplier: z.string().nullable().optional(), purchasePrice: z.number().int().min(0).nullable().optional(), expiryDate: z.string().nullable().optional() });
adminRouter.get("/inventory", mgmt, ah(async (req, res) => { const l = await db.select().from(s.inventoryItems).where(eq(s.inventoryItems.restaurantId, req.staff!.rid)).orderBy(asc(s.inventoryItems.name)); ok(res, l.map((i) => ({ ...i, low: Number(i.quantity) <= Number(i.minStock) }))); }));
adminRouter.post("/inventory", mgmt, ah(async (req, res) => { const b = parse(invBody, req.body); const [i] = await db.insert(s.inventoryItems).values({ ...b, quantity: String(b.quantity), minStock: String(b.minStock), restaurantId: req.staff!.rid }).returning(); if (b.quantity > 0) await db.insert(s.stockMovements).values({ inventoryItemId: i.id, delta: String(b.quantity), reason: "INITIAL", userId: req.staff!.id }); ok(res, i, 201); }));
adminRouter.put("/inventory/:id", mgmt, ah(async (req, res) => { const b = parse(invBody.omit({ quantity: true }).partial(), req.body); const { minStock, ...r } = b; const [i] = await db.update(s.inventoryItems).set({ ...r, ...(minStock != null ? { minStock: String(minStock) } : {}) }).where(and(eq(s.inventoryItems.id, String(req.params.id)), eq(s.inventoryItems.restaurantId, req.staff!.rid))).returning(); if (!i) throw notFound("Item not found"); ok(res, i); }));
adminRouter.delete("/inventory/:id", mgmt, ah(async (req, res) => { const r = await db.delete(s.inventoryItems).where(and(eq(s.inventoryItems.id, String(req.params.id)), eq(s.inventoryItems.restaurantId, req.staff!.rid))).returning(); if (!r.length) throw notFound("Item not found"); ok(res, { deleted: true }); }));
adminRouter.post("/inventory/:id/adjust", mgmt, ah(async (req, res) => {
  const b = parse(z.object({ delta: z.number().refine((n) => n !== 0), reason: z.string().min(2).max(100) }), req.body);
  try { const i = await adjustStock(req.staff!.rid, String(req.params.id), b.delta, `MANUAL: ${b.reason}`, req.staff!.id); if (!i) throw notFound("Item not found"); await audit(req.staff!.rid, req.staff!.id, "inventory.adjust", "inventory", i.id, b); ok(res, i); }
  catch (e: any) { if (e.message === "NEGATIVE_STOCK") throw conflict("Adjustment would make stock negative"); throw e; }
}));
adminRouter.get("/inventory/:id/movements", mgmt, ah(async (req, res) => ok(res, await db.select().from(s.stockMovements).where(eq(s.stockMovements.inventoryItemId, String(req.params.id))).orderBy(desc(s.stockMovements.createdAt)).limit(100))));

// ---------- coupons ----------
const couponBody = z.object({ code: z.string().min(3).max(24), type: z.enum(["PERCENT", "FIXED", "BOGO", "COMBO"]), value: z.number().int().min(0).default(0), minOrder: z.number().int().min(0).default(0), maxDiscount: z.number().int().min(0).nullable().optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(), usageLimit: z.number().int().min(1).nullable().optional(), perCustomerLimit: z.number().int().min(1).nullable().optional(), firstOrderOnly: z.boolean().default(false), minTier: z.enum(["SILVER", "GOLD", "PLATINUM"]).nullable().optional(), bogoProductId: z.string().uuid().nullable().optional(), active: z.boolean().default(true), startHour: z.number().int().min(0).max(23).nullable().optional(), endHour: z.number().int().min(1).max(24).nullable().optional() })
  .refine((c) => c.type !== "PERCENT" || (c.value >= 1 && c.value <= 100), "Percent must be 1–100").refine((c) => c.type !== "BOGO" || !!c.bogoProductId, "BOGO needs a product");
const cv = (b: z.infer<typeof couponBody>) => ({ ...b, code: b.code.toUpperCase(), startsAt: b.startsAt ? new Date(b.startsAt) : null, endsAt: b.endsAt ? new Date(b.endsAt) : null });
adminRouter.get("/coupons", mgmt, ah(async (req, res) => ok(res, await rows(sql`select c.*, (select count(*)::int from coupon_redemptions r where r.coupon_id=c.id) as redemptions, (select coalesce(sum(discount),0)::int from coupon_redemptions r where r.coupon_id=c.id) as discount_given from coupons c where c.restaurant_id=${req.staff!.rid} order by c.code`))));
adminRouter.post("/coupons", mgmt, ah(async (req, res) => { const b = parse(couponBody, req.body); const [c] = await db.insert(s.coupons).values({ ...cv(b), restaurantId: req.staff!.rid }).returning(); ok(res, c, 201); }));
adminRouter.put("/coupons/:id", mgmt, ah(async (req, res) => { const b = parse(couponBody, req.body); const [c] = await db.update(s.coupons).set(cv(b)).where(and(eq(s.coupons.id, String(req.params.id)), eq(s.coupons.restaurantId, req.staff!.rid))).returning(); if (!c) throw notFound("Coupon not found"); ok(res, c); }));
adminRouter.delete("/coupons/:id", mgmt, ah(async (req, res) => { const r = await db.update(s.coupons).set({ active: false }).where(and(eq(s.coupons.id, String(req.params.id)), eq(s.coupons.restaurantId, req.staff!.rid))).returning(); if (!r.length) throw notFound("Coupon not found"); ok(res, { deactivated: true }); }));

// ---------- customers, reviews, reservations, payments, audit ----------
adminRouter.get("/customers", mgmt, ah(async (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : "%"; const { page, limit, offset } = paging(req.query);
  const list = await rows(sql`select c.id, c.name, c.phone, c.email, c.created_at, a.tier, a.points, a.lifetime_points,
    (select count(*)::int from orders o where o.customer_id=c.id and o.payment_status='PAID') as visits,
    (select coalesce(sum(o.total),0)::int from orders o where o.customer_id=c.id and o.payment_status='PAID') as spent,
    (select max(o.created_at) from orders o where o.customer_id=c.id) as last_visit
    from customers c left join loyalty_accounts a on a.customer_id=c.id where c.restaurant_id=${req.staff!.rid} and (c.name ilike ${q} or c.phone ilike ${q}) order by spent desc limit ${limit} offset ${offset}`);
  out(req, res, "customers", list);
}));
adminRouter.get("/customers/:id", mgmt, ah(async (req, res) => {
  const [c] = await db.select().from(s.customers).where(and(eq(s.customers.id, String(req.params.id)), eq(s.customers.restaurantId, req.staff!.rid))); if (!c) throw notFound("Customer not found");
  const orders = await db.select().from(s.orders).where(eq(s.orders.customerId, c.id)).orderBy(desc(s.orders.createdAt)).limit(50);
  const [acc] = await db.select().from(s.loyaltyAccounts).where(eq(s.loyaltyAccounts.customerId, c.id));
  const reviews = await db.select().from(s.reviews).where(eq(s.reviews.customerId, c.id));
  ok(res, { customer: c, account: acc ?? null, orders, reviews });
}));
adminRouter.get("/reviews", mgmt, ah(async (req, res) => { const l = await db.select({ r: s.reviews, order: s.orders.orderNumber }).from(s.reviews).innerJoin(s.orders, eq(s.orders.id, s.reviews.orderId)).where(eq(s.reviews.restaurantId, req.staff!.rid)).orderBy(desc(s.reviews.createdAt)).limit(100); ok(res, l.map((x) => ({ ...x.r, orderNumber: x.order }))); }));
adminRouter.get("/reservations", mgmt, ah(async (req, res) => ok(res, await db.select().from(s.reservations).where(eq(s.reservations.restaurantId, req.staff!.rid)).orderBy(desc(s.reservations.startsAt)).limit(200))));
adminRouter.patch("/reservations/:id", mgmt, ah(async (req, res) => { const b = parse(z.object({ status: z.enum(["CONFIRMED", "SEATED", "CANCELLED", "NO_SHOW"]) }), req.body); const [r] = await db.update(s.reservations).set(b).where(and(eq(s.reservations.id, String(req.params.id)), eq(s.reservations.restaurantId, req.staff!.rid))).returning(); if (!r) throw notFound("Reservation not found"); ok(res, r); }));
adminRouter.get("/payments", mgmt, ah(async (req, res) => {
  const rid = req.staff!.rid; const { page, limit, offset } = paging(req.query);
  const list = await rows(sql`select p.id, p.created_at, p.paid_at, p.amount, p.tip, p.method, p.status, p.provider, p.test_mode, o.numbers as orders, t.number as table_number from payments p join bills b on b.id=p.bill_id join table_sessions ts on ts.id=b.table_session_id join cafe_tables t on t.id=ts.table_id
    left join lateral (select string_agg(order_number, ', ') as numbers from orders where table_session_id=ts.id) o on true where p.restaurant_id=${rid} ${req.query.status ? sql`and p.status=${String(req.query.status)}` : sql``} ${req.query.method ? sql`and p.method=${String(req.query.method)}` : sql``} order by p.created_at desc limit ${limit} offset ${offset}`);
  const summary = await rows(sql`select method, status, count(*)::int as count, coalesce(sum(amount),0)::int as amount, coalesce(sum(tip),0)::int as tips from payments where restaurant_id=${rid} group by method, status`);
  const [tax] = await rows(sql`select coalesce(sum(o.tax),0)::int as tax, coalesce(sum(o.service_charge),0)::int as service_charge, coalesce(sum(o.discount),0)::int as discount from orders o where o.restaurant_id=${rid} and o.payment_status='PAID'`);
  const [ref] = await rows(sql`select coalesce(sum(r.amount),0)::int as refunded, count(*)::int as count from refunds r join payments p on p.id=r.payment_id where p.restaurant_id=${rid}`);
  if (req.query.format === "csv") return csv(res, "payments", list);
  ok(res, { payments: list, summary, tax, refunds: ref });
}));
adminRouter.post("/payments/:id/refund", mgmt, ah(async (req, res) => { const b = parse(z.object({ amount: z.number().int().positive().optional(), reason: z.string().min(2).max(200) }), req.body); ok(res, await refundPayment(req.staff!.rid, String(req.params.id), b.amount, b.reason, req.staff!.id)); }));
adminRouter.get("/audit-logs", mgmt, ah(async (req, res) => { const { limit, offset } = paging(req.query); ok(res, await rows(sql`select a.*, u.name as user_name from audit_logs a left join users u on u.id=a.user_id where a.restaurant_id=${req.staff!.rid} order by a.created_at desc limit ${limit} offset ${offset}`)); }));
adminRouter.get("/orders/export", mgmt, ah(async (req, res) => csv(res, "orders", await rows(sql`select o.order_number, t.number as table_number, o.status, o.payment_status, o.subtotal/100.0 as subtotal, o.discount/100.0 as discount, o.tax/100.0 as tax, o.total/100.0 as total, o.created_at from orders o join cafe_tables t on t.id=o.table_id where o.restaurant_id=${req.staff!.rid} order by o.created_at desc`))));

// ---------- settings ----------
adminRouter.get("/settings", mgmt, ah(async (req, res) => { const [r] = await db.select().from(s.restaurants).where(eq(s.restaurants.id, req.staff!.rid)); ok(res, { ...r, integrations: { razorpay: !!env.RAZORPAY_KEY_ID && !!env.RAZORPAY_KEY_SECRET, razorpayWebhook: !!env.RAZORPAY_WEBHOOK_SECRET, paymentTestMode: env.PAYMENT_TEST_MODE, email: !!env.RESEND_API_KEY, cloudinary: !!env.CLOUDINARY_CLOUD_NAME } }); }));
adminRouter.put("/settings", owner, ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(80).optional(), logoUrl: z.string().max(500).nullable().optional(), address: z.string().max(300).nullable().optional(), phone: z.string().max(30).nullable().optional(), email: z.string().email().nullable().optional(), currency: z.string().length(3).optional(), taxPercent: z.number().min(0).max(50).optional(), serviceChargePercent: z.number().min(0).max(30).optional(),
    settings: z.object({ wifi: z.object({ ssid: z.string().max(60), password: z.string().max(80).optional(), security: z.enum(["WPA", "WEP", "nopass"]).optional(), instructions: z.string().max(300).optional() }).optional(), hours: z.record(z.string(), z.string()).optional(), loyalty: z.object({ pointsPerRupee: z.number().min(0).max(5), pointValuePaise: z.number().int().min(1), tiers: z.object({ SILVER: z.number().int(), GOLD: z.number().int(), PLATINUM: z.number().int() }), multiplier: z.object({ BRONZE: z.number(), SILVER: z.number(), GOLD: z.number(), PLATINUM: z.number() }), referralBonus: z.number().int().min(0), birthdayBonus: z.number().int().min(0), gameDailyCap: z.number().int().min(0) }).partial().optional(), notifications: z.object({ sound: z.boolean().optional(), email: z.boolean().optional() }).optional(), prepDefaults: z.object({ minutes: z.number().int().min(1) }).optional() }).optional() }), req.body);
  const [cur] = await db.select().from(s.restaurants).where(eq(s.restaurants.id, req.staff!.rid));
  const { settings, taxPercent, serviceChargePercent, ...rest } = b;
  const [r] = await db.update(s.restaurants).set({ ...rest, ...(taxPercent != null ? { taxPercent: String(taxPercent) } : {}), ...(serviceChargePercent != null ? { serviceChargePercent: String(serviceChargePercent) } : {}), ...(settings ? { settings: { ...(cur.settings as object), ...settings } } : {}) }).where(eq(s.restaurants.id, req.staff!.rid)).returning();
  await audit(req.staff!.rid, req.staff!.id, "settings.update", "restaurant", r.id, { fields: Object.keys(b) }); ok(res, r);
}));

// ---------- analytics (all from the database) ----------
const range = (q: any) => { const to = q.to ? new Date(String(q.to)) : new Date(); const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 30 * 86400000); if (isNaN(+from) || isNaN(+to)) throw bad("Invalid date range"); return { from, to: new Date(to.getTime() + 0) }; };
const A = Router(); adminRouter.use("/analytics", mgmt, A);
A.get("/overview", ah(async (req, res) => {
  const rid = req.staff!.rid; const day = sql`date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`;
  const [t] = await rows(sql`select coalesce(sum(o.total) filter (where o.payment_status='PAID'),0)::int as revenue, count(*) filter (where o.status not in ('CANCELLED','REJECTED'))::int as orders, coalesce(avg(o.total) filter (where o.payment_status='PAID'),0)::int as aov, count(*) filter (where o.status in ('PLACED','CONFIRMED','SENT_TO_KITCHEN','PREPARING'))::int as pending from orders o where o.restaurant_id=${rid} and o.created_at >= ${day}`);
  const [tb] = await rows(sql`select count(*) filter (where status='OCCUPIED')::int as active, count(*)::int as total from cafe_tables where restaurant_id=${rid}`);
  const [prep] = await rows(sql`select coalesce(round(avg(extract(epoch from (readied.created_at - o.created_at))/60)::numeric,1),0)::float as minutes from orders o join order_status_history readied on readied.order_id=o.id and readied.status='READY' where o.restaurant_id=${rid} and o.created_at >= now() - interval '7 days'`);
  const [sat] = await rows(sql`select coalesce(round(avg(overall)::numeric,2),0)::float as rating, count(*)::int as reviews from reviews where restaurant_id=${rid}`);
  const best = await rows(sql`select oi.name, sum(oi.quantity)::int as qty from order_items oi join orders o on o.id=oi.order_id where o.restaurant_id=${rid} and o.payment_status='PAID' and o.created_at >= now() - interval '30 days' group by oi.name order by qty desc limit 5`);
  const trend = await rows(sql`select to_char(date_trunc('day', o.created_at at time zone 'Asia/Kolkata'),'YYYY-MM-DD') as date, sum(o.total)::int as revenue, count(*)::int as orders from orders o where o.restaurant_id=${rid} and o.payment_status='PAID' and o.created_at >= now() - interval '14 days' group by 1 order by 1`);
  ok(res, { todayRevenue: t.revenue, totalOrders: t.orders, avgOrderValue: t.aov, pendingOrders: t.pending, activeTables: tb.active, totalTables: tb.total, occupancyPercent: tb.total ? Math.round((tb.active / tb.total) * 100) : 0, avgPrepMinutes: prep.minutes, satisfaction: sat.rating, reviewCount: sat.reviews, bestsellers: best, trend });
}));
A.get("/revenue", ah(async (req, res) => {
  const { from, to } = range(req.query); const g = ({ day: "day", week: "week", month: "month", year: "year" } as any)[String(req.query.granularity || "day")] || "day";
  out(req, res, "revenue", await rows(sql`select to_char(date_trunc(${sql.raw(`'${g}'`)}, o.created_at at time zone 'Asia/Kolkata'),'YYYY-MM-DD') as period, count(*)::int as orders, coalesce(sum(o.subtotal),0)::int as subtotal, coalesce(sum(o.discount),0)::int as discount, coalesce(sum(o.tax),0)::int as tax, coalesce(sum(o.total),0)::int as revenue from orders o where o.restaurant_id=${req.staff!.rid} and o.payment_status='PAID' and o.created_at between ${from} and ${to} group by 1 order by 1`));
}));
A.get("/products", ah(async (req, res) => { const { from, to } = range(req.query); out(req, res, "products", await rows(sql`select oi.name, c.name as category, sum(oi.quantity)::int as qty, sum(oi.line_total)::int as revenue from order_items oi join orders o on o.id=oi.order_id join products p on p.id=oi.product_id join categories c on c.id=p.category_id where o.restaurant_id=${req.staff!.rid} and o.payment_status='PAID' and o.created_at between ${from} and ${to} group by oi.name, c.name order by revenue desc limit 50`)); }));
A.get("/categories", ah(async (req, res) => { const { from, to } = range(req.query); out(req, res, "categories", await rows(sql`select c.name as category, sum(oi.quantity)::int as qty, sum(oi.line_total)::int as revenue from order_items oi join orders o on o.id=oi.order_id join products p on p.id=oi.product_id join categories c on c.id=p.category_id where o.restaurant_id=${req.staff!.rid} and o.payment_status='PAID' and o.created_at between ${from} and ${to} group by c.name order by revenue desc`)); }));
A.get("/peak-hours", ah(async (req, res) => { const { from, to } = range(req.query); out(req, res, "peak-hours", await rows(sql`select extract(hour from o.created_at at time zone 'Asia/Kolkata')::int as hour, count(*)::int as orders, coalesce(sum(o.total),0)::int as revenue from orders o where o.restaurant_id=${req.staff!.rid} and o.status not in ('CANCELLED','REJECTED') and o.created_at between ${from} and ${to} group by 1 order by 1`)); }));
A.get("/tables", ah(async (req, res) => { const { from, to } = range(req.query); out(req, res, "table-utilization", await rows(sql`select t.number as table_number, count(distinct ts.id)::int as sessions, coalesce(round(sum(extract(epoch from (coalesce(ts.closed_at, now()) - ts.created_at))/60)::numeric),0)::int as occupied_minutes, coalesce(sum(o.total) filter (where o.payment_status='PAID'),0)::int as revenue from cafe_tables t left join table_sessions ts on ts.table_id=t.id and ts.created_at between ${from} and ${to} left join orders o on o.table_session_id=ts.id where t.restaurant_id=${req.staff!.rid} group by t.number order by t.number`)); }));
A.get("/staff", ah(async (req, res) => { const { from, to } = range(req.query); out(req, res, "staff-performance", await rows(sql`select u.name, u.role, (select count(*)::int from service_requests r where r.assigned_to=u.id and r.status='COMPLETED' and r.created_at between ${from} and ${to}) as requests_completed, (select coalesce(round(avg(extract(epoch from (r.completed_at-r.created_at))/60)::numeric,1),0)::float from service_requests r where r.assigned_to=u.id and r.status='COMPLETED' and r.created_at between ${from} and ${to}) as avg_request_minutes, (select count(*)::int from order_status_history h where h.by_user_id=u.id and h.created_at between ${from} and ${to}) as order_actions from users u where u.restaurant_id=${req.staff!.rid} and u.role in ('WAITER','KITCHEN_STAFF','CASHIER') order by requests_completed desc`)); }));
A.get("/retention", ah(async (req, res) => { const [r] = await rows(sql`select count(*)::int as customers, count(*) filter (where n>=2)::int as repeat_customers, coalesce(round(100.0*count(*) filter (where n>=2)/nullif(count(*),0),1),0)::float as repeat_percent from (select c.id, count(o.id) filter (where o.payment_status='PAID') as n from customers c left join orders o on o.customer_id=c.id where c.restaurant_id=${req.staff!.rid} group by c.id) x`); ok(res, r); }));
A.get("/prep-time", ah(async (req, res) => { const { from, to } = range(req.query); out(req, res, "prep-time", await rows(sql`select coalesce(st.name,'Unassigned') as station, count(*)::int as tickets, coalesce(round(avg(extract(epoch from (k.ready_at-k.started_at))/60)::numeric,1),0)::float as avg_minutes from kitchen_tickets k join orders o on o.id=k.order_id left join kitchen_stations st on st.id=k.station_id where o.restaurant_id=${req.staff!.rid} and k.ready_at is not null and k.started_at is not null and o.created_at between ${from} and ${to} group by 1 order by 1`)); }));
A.get("/coupons", ah(async (req, res) => { out(req, res, "coupon-performance", await rows(sql`select c.code, c.type, count(r.id)::int as redemptions, coalesce(sum(r.discount),0)::int as discount_given, coalesce(sum(o.total),0)::int as order_revenue from coupons c left join coupon_redemptions r on r.coupon_id=c.id left join orders o on o.id=r.order_id where c.restaurant_id=${req.staff!.rid} group by c.id order by redemptions desc`)); }));
A.get("/payment-methods", ah(async (req, res) => { const { from, to } = range(req.query); out(req, res, "payment-methods", await rows(sql`select method, count(*)::int as payments, coalesce(sum(amount),0)::int as amount, coalesce(sum(tip),0)::int as tips from payments where restaurant_id=${req.staff!.rid} and status in ('PAID','PARTIALLY_REFUNDED') and created_at between ${from} and ${to} group by method order by amount desc`)); }));
