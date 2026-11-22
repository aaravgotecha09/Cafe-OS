import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db, schema as s } from "../db";
import { ah, ok, paging, parse } from "../utils/http";
import { bad, forbidden, notFound } from "../utils/errors";
import { ROLES, requireStaff } from "../middleware/auth";
import { changeStatus, kitchenQueue, loadOrder, setItemReady, ticketAction } from "../services/orders";
import { billDetail, finalize, initiatePayment } from "../services/billing";
import { emitTo, rooms } from "../sockets";

export const staffRouter = Router();
const floor = requireStaff(...ROLES.FLOOR);
const mgmt = requireStaff(...ROLES.MGMT);
const urgency: Record<string, number> = { CALL_WAITER: 6, BILL: 5, ASSISTANCE: 4, CLEANING: 2, WATER: 2, NAPKINS: 1, CUTLERY: 1, CUSTOM: 3 };

staffRouter.get("/overview", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => {
  const rid = req.staff!.rid;
  const tables = await db.select().from(s.cafeTables).where(eq(s.cafeTables.restaurantId, rid));
  const orders = await db.select({ status: s.orders.status, n: sql<number>`count(*)` }).from(s.orders).where(and(eq(s.orders.restaurantId, rid), sql`${s.orders.createdAt} >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`)).groupBy(s.orders.status);
  const [{ n: reqs }] = await db.select({ n: sql<number>`count(*)` }).from(s.serviceRequests).where(and(eq(s.serviceRequests.restaurantId, rid), notInArray(s.serviceRequests.status, ["COMPLETED"])));
  const [{ avg }] = await db.select({ avg: sql<number>`coalesce(avg(extract(epoch from (${s.orderStatusHistory.createdAt} - ${s.orders.createdAt}))/60),0)` }).from(s.orderStatusHistory).innerJoin(s.orders, eq(s.orders.id, s.orderStatusHistory.orderId)).where(and(eq(s.orders.restaurantId, rid), eq(s.orderStatusHistory.status, "SERVED"), sql`${s.orders.createdAt} > now() - interval '1 day'`));
  const c = (st: string[]) => orders.filter((o) => st.includes(o.status)).reduce((a, o) => a + Number(o.n), 0);
  ok(res, { totalTables: tables.length, occupied: tables.filter((t) => t.status === "OCCUPIED").length, available: tables.filter((t) => t.status === "AVAILABLE").length, reserved: tables.filter((t) => t.status === "RESERVED").length, cleaning: tables.filter((t) => t.status === "CLEANING").length, requesting: Number(reqs),
    pendingOrders: c(["PLACED", "CONFIRMED"]), preparingOrders: c(["SENT_TO_KITCHEN", "PREPARING"]), readyOrders: c(["READY"]), completedOrders: c(["SERVED", "COMPLETED"]), avgServiceMinutes: Math.round(Number(avg) * 10) / 10 });
}));
staffRouter.get("/floor", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => {
  const rid = req.staff!.rid;
  const tables = await db.select({ t: s.cafeTables, waiter: s.users.name }).from(s.cafeTables).leftJoin(s.users, eq(s.users.id, s.cafeTables.assignedWaiterId)).where(eq(s.cafeTables.restaurantId, rid)).orderBy(asc(s.cafeTables.number));
  const active = await db.select().from(s.orders).where(and(eq(s.orders.restaurantId, rid), notInArray(s.orders.status, ["COMPLETED", "CANCELLED", "REJECTED"])));
  const reqs = await db.select().from(s.serviceRequests).where(and(eq(s.serviceRequests.restaurantId, rid), notInArray(s.serviceRequests.status, ["COMPLETED"])));
  ok(res, tables.map(({ t, waiter }) => {
    const os = active.filter((o) => o.tableId === t.id); const rs = reqs.filter((r) => r.tableId === t.id);
    const flag = rs.length ? "REQUEST" : os.some((o) => o.status === "READY") ? "FOOD_READY" : os.some((o) => ["PLACED", "CONFIRMED"].includes(o.status)) ? "ORDER_PENDING" : null;
    return { id: t.id, number: t.number, capacity: t.capacity, location: t.location, status: t.status, posX: t.posX, posY: t.posY, assignedWaiterId: t.assignedWaiterId, waiter, flag, activeOrders: os.length, openRequests: rs.length };
  }));
}));
staffRouter.get("/tables/:id", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => {
  const [t] = await db.select().from(s.cafeTables).where(and(eq(s.cafeTables.id, String(req.params.id)), eq(s.cafeTables.restaurantId, req.staff!.rid)));
  if (!t) throw notFound("Table not found");
  const [session] = await db.select().from(s.tableSessions).where(and(eq(s.tableSessions.tableId, t.id), isNull(s.tableSessions.closedAt)));
  const orders = await db.select().from(s.orders).where(eq(s.orders.tableId, t.id)).orderBy(desc(s.orders.createdAt)).limit(30);
  const requests = await db.select().from(s.serviceRequests).where(eq(s.serviceRequests.tableId, t.id)).orderBy(desc(s.serviceRequests.createdAt)).limit(20);
  const items = orders.length ? await db.select().from(s.orderItems).where(inArray(s.orderItems.orderId, orders.map((o) => o.id))) : [];
  ok(res, { table: t, session: session ?? null, orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.orderId === o.id) })), requests, bill: session ? await billDetail(req.staff!.rid, session.id) : null });
}));
staffRouter.patch("/tables/:id", floor, ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(s.tableStatusEnum.enumValues).optional(), assignedWaiterId: z.string().uuid().nullable().optional() }), req.body);
  if (b.assignedWaiterId !== undefined && !["SUPER_ADMIN", "RESTAURANT_OWNER", "MANAGER"].includes(req.staff!.role)) throw forbidden("Only managers can assign waiters");
  if (b.assignedWaiterId) { const [w] = await db.select().from(s.users).where(and(eq(s.users.id, b.assignedWaiterId), eq(s.users.restaurantId, req.staff!.rid), eq(s.users.role, "WAITER"))); if (!w) throw bad("Waiter not found"); }
  if (b.status === "AVAILABLE") { const [live] = await db.select({ id: s.tableSessions.id }).from(s.tableSessions).where(and(eq(s.tableSessions.tableId, String(req.params.id)), isNull(s.tableSessions.closedAt))); if (live) { const unpaid = await db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.tableSessionId, live.id), notInArray(s.orders.status, ["CANCELLED", "REJECTED", "COMPLETED"]))); if (unpaid.length) throw bad("Table has unfinished orders"); await db.update(s.tableSessions).set({ closedAt: new Date() }).where(eq(s.tableSessions.id, live.id)); } }
  const [t] = await db.update(s.cafeTables).set(b).where(and(eq(s.cafeTables.id, String(req.params.id)), eq(s.cafeTables.restaurantId, req.staff!.rid))).returning();
  if (!t) throw notFound("Table not found");
  emitTo(rooms.staff(req.staff!.rid), "table:status_updated", { tableId: t.id, status: t.status, assignedWaiterId: t.assignedWaiterId }); ok(res, t);
}));
staffRouter.get("/waiters", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => ok(res, await db.select({ id: s.users.id, name: s.users.name, section: s.users.section, available: s.users.available }).from(s.users).where(and(eq(s.users.restaurantId, req.staff!.rid), eq(s.users.role, "WAITER"), eq(s.users.active, true))))));

// ---- orders ----
staffRouter.get("/orders", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => {
  const { page, limit, offset } = paging(req.query); const rid = req.staff!.rid;
  const st = req.query.status ? String(req.query.status).split(",").filter((x) => (s.orderStatusEnum.enumValues as readonly string[]).includes(x)) as any[] : null;
  const where = and(eq(s.orders.restaurantId, rid), st ? inArray(s.orders.status, st) : sql`true`, req.query.q ? ilike(s.orders.orderNumber, `%${req.query.q}%`) : sql`true`);
  const rows = await db.select({ o: s.orders, tn: s.cafeTables.number, staff: s.users.name }).from(s.orders).innerJoin(s.cafeTables, eq(s.cafeTables.id, s.orders.tableId)).leftJoin(s.users, eq(s.users.id, s.orders.assignedStaffId)).where(where).orderBy(desc(s.orders.createdAt)).limit(limit).offset(offset);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(s.orders).where(where);
  const items = rows.length ? await db.select().from(s.orderItems).where(inArray(s.orderItems.orderId, rows.map((r) => r.o.id))) : [];
  ok(res, rows.map((r) => ({ ...r.o, tableNumber: r.tn, assignedStaff: r.staff, items: items.filter((i) => i.orderId === r.o.id) })), 200, { page, limit, total: Number(n) });
}));
staffRouter.get("/orders/:id", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => { const o = await loadOrder(String(req.params.id), req.staff!.rid); if (!o) throw notFound("Order not found"); ok(res, o); }));
staffRouter.post("/orders/:id/status", floor, ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(["CONFIRMED", "SENT_TO_KITCHEN", "REJECTED", "SERVED", "CANCELLED", "COMPLETED"]), note: z.string().max(300).optional() }), req.body);
  ok(res, await changeStatus(String(req.params.id), b.status, { id: req.staff!.id, role: req.staff!.role, rid: req.staff!.rid }, b.note));
}));
staffRouter.patch("/orders/:id", floor, ah(async (req, res) => {
  const b = parse(z.object({ notes: z.string().max(500).optional(), assignedStaffId: z.string().uuid().nullable().optional() }), req.body);
  const [o] = await db.update(s.orders).set(b).where(and(eq(s.orders.id, String(req.params.id)), eq(s.orders.restaurantId, req.staff!.rid))).returning();
  if (!o) throw notFound("Order not found"); ok(res, o);
}));

// ---- service requests ----
staffRouter.get("/requests", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => {
  const hist = req.query.history === "true";
  const rows = await db.select({ r: s.serviceRequests, tn: s.cafeTables.number, who: s.users.name }).from(s.serviceRequests).innerJoin(s.cafeTables, eq(s.cafeTables.id, s.serviceRequests.tableId)).leftJoin(s.users, eq(s.users.id, s.serviceRequests.assignedTo))
    .where(and(eq(s.serviceRequests.restaurantId, req.staff!.rid), hist ? eq(s.serviceRequests.status, "COMPLETED") : notInArray(s.serviceRequests.status, ["COMPLETED"]))).orderBy(desc(s.serviceRequests.createdAt)).limit(hist ? 100 : 200);
  const list = rows.map(({ r, tn, who }) => { const waited = (Date.now() - r.createdAt.getTime()) / 60000; return { ...r, tableNumber: tn, assignedName: who, waitedMinutes: Math.round(waited * 10) / 10, priorityScore: Math.round((waited + urgency[r.type]) * 10) / 10 }; });
  ok(res, hist ? list : list.sort((a, b) => b.priorityScore - a.priorityScore));
}));
const reqAction = (path: string, to: "ACKNOWLEDGED" | "IN_PROGRESS" | "COMPLETED") => staffRouter.post(`/requests/:id/${path}`, floor, ah(async (req, res) => {
  const allowed = to === "ACKNOWLEDGED" ? ["PENDING"] : to === "IN_PROGRESS" ? ["PENDING", "ACKNOWLEDGED"] : ["PENDING", "ACKNOWLEDGED", "IN_PROGRESS"];
  const [r] = await db.update(s.serviceRequests).set({ status: to, assignedTo: req.staff!.id, ...(to === "ACKNOWLEDGED" ? { acknowledgedAt: new Date() } : {}), ...(to === "COMPLETED" ? { completedAt: new Date() } : {}) })
    .where(and(eq(s.serviceRequests.id, String(req.params.id)), eq(s.serviceRequests.restaurantId, req.staff!.rid), inArray(s.serviceRequests.status, allowed as any))).returning();
  if (!r) throw bad("Request not found or already handled");
  emitTo([rooms.staff(r.restaurantId), rooms.table(r.restaurantId, r.tableId)], to === "COMPLETED" ? "waiter:request_completed" : "waiter:request_accepted", { ...r, staffName: req.staff!.name });
  ok(res, r);
}));
reqAction("acknowledge", "ACKNOWLEDGED"); reqAction("progress", "IN_PROGRESS"); reqAction("complete", "COMPLETED");
staffRouter.post("/requests/:id/assign", mgmt, ah(async (req, res) => {
  const b = parse(z.object({ userId: z.string().uuid() }), req.body);
  const [u] = await db.select().from(s.users).where(and(eq(s.users.id, b.userId), eq(s.users.restaurantId, req.staff!.rid)));
  if (!u) throw bad("Staff not found");
  const [r] = await db.update(s.serviceRequests).set({ assignedTo: u.id }).where(and(eq(s.serviceRequests.id, String(req.params.id)), eq(s.serviceRequests.restaurantId, req.staff!.rid))).returning();
  if (!r) throw notFound("Request not found"); emitTo(rooms.staff(r.restaurantId), "waiter:request_accepted", r); ok(res, r);
}));

// ---- billing at the table (cash etc.) ----
staffRouter.get("/billing/:tableSessionId", floor, ah(async (req, res) => { const d = await billDetail(req.staff!.rid, String(req.params.tableSessionId)); if (!d) throw notFound("No bill yet"); ok(res, d); }));
staffRouter.post("/billing/cash", floor, ah(async (req, res) => {
  const b = parse(z.object({ tableSessionId: z.string().uuid(), splitId: z.string().uuid().optional(), tipAmount: z.number().int().min(0).optional(), idempotencyKey: z.string().min(8) }), req.body);
  const [ts] = await db.select().from(s.tableSessions).where(and(eq(s.tableSessions.id, b.tableSessionId), eq(s.tableSessions.restaurantId, req.staff!.rid)));
  if (!ts) throw notFound("Table session not found");
  ok(res, await initiatePayment(req.staff!.rid, { tableSessionId: ts.id, splitId: b.splitId, method: "CASH", tipAmount: b.tipAmount, idempotencyKey: b.idempotencyKey, collectedBy: req.staff!.id }), 201);
}));

// ---- customers / reservations / waitlist / notifications ----
staffRouter.get("/customers", floor, ah(async (req, res) => {
  const q = String(req.query.q || "");
  ok(res, await db.select({ id: s.customers.id, name: s.customers.name, phone: s.customers.phone, tier: s.loyaltyAccounts.tier, points: s.loyaltyAccounts.points }).from(s.customers).leftJoin(s.loyaltyAccounts, eq(s.loyaltyAccounts.customerId, s.customers.id)).where(and(eq(s.customers.restaurantId, req.staff!.rid), q ? ilike(s.customers.name, `%${q}%`) : sql`true`)).limit(50));
}));
staffRouter.get("/reservations", floor, ah(async (req, res) => ok(res, await db.select().from(s.reservations).where(and(eq(s.reservations.restaurantId, req.staff!.rid), sql`${s.reservations.startsAt} > now() - interval '1 day'`)).orderBy(asc(s.reservations.startsAt)))));
staffRouter.get("/waitlist", floor, ah(async (req, res) => ok(res, await db.select().from(s.waitlist).where(and(eq(s.waitlist.restaurantId, req.staff!.rid), eq(s.waitlist.status, "WAITING"))).orderBy(asc(s.waitlist.createdAt)))));
staffRouter.post("/waitlist/:id/notify", floor, ah(async (req, res) => {
  const [w] = await db.update(s.waitlist).set({ status: "NOTIFIED", notifiedAt: new Date() }).where(and(eq(s.waitlist.id, String(req.params.id)), eq(s.waitlist.restaurantId, req.staff!.rid), eq(s.waitlist.status, "WAITING"))).returning();
  if (!w) throw notFound("Waitlist entry not found"); ok(res, w);
}));
staffRouter.get("/notifications", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => ok(res, await db.select().from(s.notifications).where(and(eq(s.notifications.restaurantId, req.staff!.rid), sql`(${s.notifications.role} is null or ${s.notifications.role} = ${req.staff!.role} or ${req.staff!.role} in ('MANAGER','RESTAURANT_OWNER','SUPER_ADMIN'))`)).orderBy(desc(s.notifications.createdAt)).limit(50))));
staffRouter.post("/notifications/read", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => { await db.update(s.notifications).set({ read: true }).where(eq(s.notifications.restaurantId, req.staff!.rid)); ok(res, { read: true }); }));

// ---- kitchen ----
export const kitchenRouter = Router();
const kitchen = requireStaff(...ROLES.KITCHEN);
kitchenRouter.get("/stations", requireStaff(...ROLES.ANY_STAFF), ah(async (req, res) => ok(res, await db.select().from(s.kitchenStations).where(eq(s.kitchenStations.restaurantId, req.staff!.rid)))));
kitchenRouter.get("/queue", kitchen, ah(async (req, res) => ok(res, await kitchenQueue(req.staff!.rid, req.query.station ? String(req.query.station) : undefined))));
kitchenRouter.get("/history", kitchen, ah(async (req, res) => {
  const rows = await db.select({ t: s.kitchenTickets, o: s.orders.orderNumber, st: s.kitchenStations.name }).from(s.kitchenTickets).innerJoin(s.orders, eq(s.orders.id, s.kitchenTickets.orderId)).leftJoin(s.kitchenStations, eq(s.kitchenStations.id, s.kitchenTickets.stationId)).where(and(eq(s.orders.restaurantId, req.staff!.rid), eq(s.kitchenTickets.status, "COMPLETED"))).orderBy(desc(s.kitchenTickets.createdAt)).limit(100);
  ok(res, rows.map((r) => ({ ...r.t, orderNumber: r.o, station: r.st, prepMinutes: r.t.readyAt && r.t.startedAt ? Math.round((+r.t.readyAt - +r.t.startedAt) / 6000) / 10 : null })));
}));
kitchenRouter.post("/tickets/:id/:action", kitchen, ah(async (req, res) => {
  const action = z.enum(["accept", "start", "ready", "note", "pickup", "flag"]).parse(req.params.action);
  const b = parse(z.object({ notes: z.string().max(300).optional(), itemId: z.string().uuid().optional() }), req.body || {});
  ok(res, await ticketAction(String(req.params.id), action, { id: req.staff!.id, role: req.staff!.role, rid: req.staff!.rid }, b));
}));
kitchenRouter.post("/items/:id/ready", kitchen, ah(async (req, res) => {
  const b = parse(z.object({ ready: z.boolean().default(true) }), req.body || {});
  ok(res, await setItemReady(String(req.params.id), b.ready, { id: req.staff!.id, role: req.staff!.role, rid: req.staff!.rid }));
}));
