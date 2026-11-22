import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, schema as s, Executor, Tx } from "../db";
import { bad, conflict, forbidden, notFound } from "../utils/errors";
import { emitTo, rooms } from "../sockets";
import { CartLine, priceCart } from "./pricing";
import { addPoints, reverseForOrder } from "./loyalty";
import { consumeForOrder } from "./inventory";
import { notify } from "./notify";
import { settleSession } from "./billing";

type Status = (typeof s.orderStatusEnum.enumValues)[number];
const FLOW: Record<string, Status[]> = {
  PLACED: ["CONFIRMED", "SENT_TO_KITCHEN", "REJECTED", "CANCELLED"],
  CONFIRMED: ["SENT_TO_KITCHEN", "CANCELLED"],
  SENT_TO_KITCHEN: ["PREPARING", "READY", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED"],
  SERVED: ["COMPLETED"],
};
const MGMT = ["SUPER_ADMIN", "RESTAURANT_OWNER", "MANAGER"];
export type Actor = { id: string | null; role: string; rid: string };

export async function createOrder(ctx: { rid: string; tableId: string; tableSessionId: string; sessionId: string; customerId: string | null }, body: { lines: CartLine[]; couponCode?: string; redeemPoints?: number; notes?: string; customerName?: string }) {
  const result = await db.transaction(async (tx) => {
    const [lock] = await tx.select({ paid: s.bills.paidAmount }).from(s.bills).where(eq(s.bills.tableSessionId, ctx.tableSessionId));
    if (lock && lock.paid > 0) throw conflict("Payment has started for this table — please ask staff to add more items");
    const priced = await priceCart(ctx.rid, body.lines, { couponCode: body.couponCode, customerId: ctx.customerId, redeemPoints: body.redeemPoints }, tx);
    const orderNumber = `OO-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const [order] = await tx.insert(s.orders).values({
      restaurantId: ctx.rid, orderNumber, tableId: ctx.tableId, tableSessionId: ctx.tableSessionId, customerSessionId: ctx.sessionId, customerId: ctx.customerId,
      subtotal: priced.subtotal, discount: priced.discount, tax: priced.tax, serviceCharge: priced.serviceCharge, total: priced.total,
      couponId: priced.couponId, couponCode: priced.couponCode, customerName: body.customerName ?? null, notes: body.notes ?? null, etaMinutes: priced.etaMinutes,
    }).returning();
    await tx.insert(s.orderItems).values(priced.lines.map((l) => ({ orderId: order.id, productId: l.productId, stationId: l.stationId, name: l.name, variantName: l.variantName, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, customizations: l.customizations, allergens: l.allergens, instructions: l.instructions })));
    await tx.insert(s.orderStatusHistory).values({ orderId: order.id, status: "PLACED" });
    if (priced.couponId) await tx.insert(s.couponRedemptions).values({ couponId: priced.couponId, orderId: order.id, customerId: ctx.customerId, discount: priced.couponDiscount });
    if (priced.pointsRedeemed && ctx.customerId) await addPoints(ctx.rid, ctx.customerId, -priced.pointsRedeemed, "REDEEM", `redeem:${order.id}`, `Order ${orderNumber}`, tx);
    const [fallback] = await tx.select().from(s.kitchenStations).where(eq(s.kitchenStations.restaurantId, ctx.rid)).limit(1);
    const stationIds = [...new Set(priced.lines.map((l) => l.stationId ?? fallback?.id ?? null))];
    await tx.insert(s.kitchenTickets).values(stationIds.map((stationId) => ({ orderId: order.id, stationId })));
    if (fallback) await tx.update(s.orderItems).set({ stationId: sql`coalesce(${s.orderItems.stationId}, ${fallback.id}::uuid)` }).where(eq(s.orderItems.orderId, order.id));
    const [t] = await tx.update(s.cafeTables).set({ status: "OCCUPIED" }).where(and(eq(s.cafeTables.id, ctx.tableId), ne(s.cafeTables.status, "OCCUPIED"))).returning();
    return { order, table: t, priced };
  });
  const full = await loadOrder(result.order.id, ctx.rid);
  emitTo(rooms.table(ctx.rid, ctx.tableId), "customer:order_created", full);
  emitTo(rooms.staff(ctx.rid), "staff:order_received", full);
  if (result.table) emitTo(rooms.staff(ctx.rid), "table:status_updated", { tableId: ctx.tableId, status: "OCCUPIED" });
  await notify(ctx.rid, { role: "WAITER", title: `New order ${result.order.orderNumber}`, body: `Table order awaiting confirmation`, kind: "order" });
  return full;
}

export async function loadOrder(id: string, rid: string) {
  const [o] = await db.select().from(s.orders).where(and(eq(s.orders.id, id), eq(s.orders.restaurantId, rid)));
  if (!o) return null;
  const [items, tickets, history, [t]] = await Promise.all([
    db.select().from(s.orderItems).where(eq(s.orderItems.orderId, id)),
    db.select().from(s.kitchenTickets).where(eq(s.kitchenTickets.orderId, id)),
    db.select().from(s.orderStatusHistory).where(eq(s.orderStatusHistory.orderId, id)).orderBy(s.orderStatusHistory.createdAt),
    db.select({ number: s.cafeTables.number }).from(s.cafeTables).where(eq(s.cafeTables.id, o.tableId)),
  ]);
  return { ...o, tableNumber: t?.number, items, tickets, history };
}

async function record(tx: Executor, o: typeof s.orders.$inferSelect, status: Status, actor: Actor, note?: string) {
  await tx.update(s.orders).set({ status, updatedAt: new Date(), ...(status === "REJECTED" ? { rejectReason: note } : {}) }).where(eq(s.orders.id, o.id));
  await tx.insert(s.orderStatusHistory).values({ orderId: o.id, status, byUserId: actor.id, note });
}
async function broadcast(orderId: string, rid: string, extra?: string) {
  const full = await loadOrder(orderId, rid);
  if (!full) return;
  emitTo([rooms.order(orderId), rooms.table(rid, full.tableId), rooms.staff(rid)], "order:status_updated", full);
  if (extra) emitTo(rooms.role(rid, "KITCHEN_STAFF"), extra, full);
  return full;
}

export async function changeStatus(orderId: string, to: Status, actor: Actor, note?: string) {
  const out = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(s.orders).where(and(eq(s.orders.id, orderId), eq(s.orders.restaurantId, actor.rid))).for("update");
    if (!o) throw notFound("Order not found");
    if (!(FLOW[o.status] || []).includes(to)) throw conflict(`Cannot move order from ${o.status} to ${to}`);
    const isMgmt = MGMT.includes(actor.role);
    if (to === "CANCELLED" && o.status !== "PLACED" && !isMgmt) throw forbidden("Only a manager can cancel an order already in progress");
    if (to === "CANCELLED" && o.paymentStatus === "PAID") throw conflict("Paid orders must be refunded instead");
    if (to === "COMPLETED" && !isMgmt) throw forbidden();
    if (to === "REJECTED" && !note) throw bad("A rejection reason is required");
    if (to === "SENT_TO_KITCHEN" && o.status === "PLACED") await record(tx, o, "CONFIRMED", actor);
    await record(tx, o, to, actor, note);
    if (to === "SENT_TO_KITCHEN") await consumeForOrder(o.id, actor.id, tx);
    if (to === "SERVED") { await settleSession(tx, actor.rid, o.tableSessionId); await tx.update(s.kitchenTickets).set({ status: "COMPLETED" }).where(eq(s.kitchenTickets.orderId, o.id)); await tx.update(s.orderItems).set({ served: true }).where(eq(s.orderItems.orderId, o.id)); }
    if (["REJECTED", "CANCELLED"].includes(to)) {
      await tx.delete(s.couponRedemptions).where(eq(s.couponRedemptions.orderId, o.id));
      if (o.customerId) {
        const [red] = await tx.select().from(s.loyaltyTransactions).innerJoin(s.loyaltyAccounts, eq(s.loyaltyAccounts.id, s.loyaltyTransactions.accountId)).where(and(eq(s.loyaltyAccounts.customerId, o.customerId), eq(s.loyaltyTransactions.refKey, `redeem:${o.id}`)));
        if (red) await addPoints(o.restaurantId, o.customerId, -red.loyalty_transactions.points, "REVERSAL", `unredeem:${o.id}`, `Order ${o.orderNumber} ${to.toLowerCase()}`, tx);
      }
      await tx.update(s.kitchenTickets).set({ status: "COMPLETED" }).where(eq(s.kitchenTickets.orderId, o.id));
    }
    return o;
  });
  const full = await broadcast(orderId, actor.rid, to === "SENT_TO_KITCHEN" ? "kitchen:order_received" : undefined);
  if (to === "READY") await notify(actor.rid, { role: "WAITER", title: `Order ${out.orderNumber} ready`, body: "Ready for pickup", kind: "order" });
  return full;
}

/** Called after any ticket/item change: derive order status from tickets. */
export async function syncOrderFromTickets(tx: Executor, orderId: string, actor: Actor) {
  const [o] = await tx.select().from(s.orders).where(eq(s.orders.id, orderId)).for("update");
  if (!o || !["SENT_TO_KITCHEN", "PREPARING"].includes(o.status)) return;
  const tickets = await tx.select().from(s.kitchenTickets).where(eq(s.kitchenTickets.orderId, orderId));
  const allReady = tickets.every((t) => ["READY", "COMPLETED"].includes(t.status));
  const anyActive = tickets.some((t) => ["PREPARING", "READY"].includes(t.status));
  if (allReady && o.status !== "READY") await record(tx, o, "READY", actor);
  else if (!allReady && anyActive && o.status === "SENT_TO_KITCHEN") await record(tx, o, "PREPARING", actor);
}

export async function ticketAction(ticketId: string, action: "accept" | "start" | "ready" | "note" | "pickup" | "flag", actor: Actor, body: { notes?: string; itemId?: string } = {}) {
  const orderId = await db.transaction(async (tx) => {
    const [t] = await tx.select({ t: s.kitchenTickets, o: s.orders }).from(s.kitchenTickets).innerJoin(s.orders, eq(s.orders.id, s.kitchenTickets.orderId)).where(and(eq(s.kitchenTickets.id, ticketId), eq(s.orders.restaurantId, actor.rid))).for("update");
    if (!t) throw notFound("Ticket not found");
    if (!["SENT_TO_KITCHEN", "PREPARING", "READY"].includes(t.o.status)) throw conflict("Order is not in the kitchen");
    const tk = t.t;
    if (action === "accept") { if (tk.status !== "NEW") throw conflict("Ticket already accepted"); await tx.update(s.kitchenTickets).set({ status: "ACCEPTED" }).where(eq(s.kitchenTickets.id, tk.id)); }
    else if (action === "start") { if (!["NEW", "ACCEPTED"].includes(tk.status)) throw conflict("Cannot start"); await tx.update(s.kitchenTickets).set({ status: "PREPARING", startedAt: new Date() }).where(eq(s.kitchenTickets.id, tk.id)); }
    else if (action === "ready") {
      if (tk.status === "READY") throw conflict("Already ready");
      await tx.update(s.kitchenTickets).set({ status: "READY", readyAt: new Date(), startedAt: tk.startedAt ?? new Date() }).where(eq(s.kitchenTickets.id, tk.id));
      await tx.update(s.orderItems).set({ ready: true }).where(and(eq(s.orderItems.orderId, tk.orderId), tk.stationId ? eq(s.orderItems.stationId, tk.stationId) : isNull(s.orderItems.stationId)));
    }
    else if (action === "note") await tx.update(s.kitchenTickets).set({ notes: body.notes ?? null }).where(eq(s.kitchenTickets.id, tk.id));
    else if (action === "pickup") await tx.update(s.kitchenTickets).set({ pickupRequested: true }).where(eq(s.kitchenTickets.id, tk.id));
    else if (action === "flag") {
      if (!body.itemId) throw bad("itemId required");
      const [it] = await tx.select().from(s.orderItems).where(and(eq(s.orderItems.id, body.itemId), eq(s.orderItems.orderId, tk.orderId)));
      if (!it) throw notFound("Item not found");
      await tx.update(s.products).set({ available: false }).where(eq(s.products.id, it.productId));
      await tx.update(s.kitchenTickets).set({ notes: `UNAVAILABLE: ${it.name}${body.notes ? " — " + body.notes : ""}` }).where(eq(s.kitchenTickets.id, tk.id));
    }
    await syncOrderFromTickets(tx, tk.orderId, actor);
    return tk.orderId;
  });
  const full = await broadcast(orderId, actor.rid, "kitchen:order_received");
  const [tk] = await db.select().from(s.kitchenTickets).where(eq(s.kitchenTickets.id, ticketId));
  if (action === "ready") emitTo(rooms.staff(actor.rid), "kitchen:item_ready", { orderId, ticket: tk });
  if (action === "pickup") await notify(actor.rid, { role: "WAITER", title: `Pickup requested — ${full?.orderNumber}`, body: `Table ${full?.tableNumber}`, kind: "pickup" });
  if (action === "flag") await notify(actor.rid, { role: "MANAGER", title: "Ingredient unavailable", body: tk.notes ?? "", kind: "inventory" });
  return full;
}

export async function setItemReady(itemId: string, ready: boolean, actor: Actor) {
  const orderId = await db.transaction(async (tx) => {
    const [row] = await tx.select({ it: s.orderItems, o: s.orders }).from(s.orderItems).innerJoin(s.orders, eq(s.orders.id, s.orderItems.orderId)).where(and(eq(s.orderItems.id, itemId), eq(s.orders.restaurantId, actor.rid)));
    if (!row) throw notFound("Item not found");
    if (!["SENT_TO_KITCHEN", "PREPARING"].includes(row.o.status)) throw conflict("Order is not being prepared");
    await tx.update(s.orderItems).set({ ready }).where(eq(s.orderItems.id, itemId));
    const siblings = await tx.select().from(s.orderItems).where(and(eq(s.orderItems.orderId, row.o.id), row.it.stationId ? eq(s.orderItems.stationId, row.it.stationId) : isNull(s.orderItems.stationId)));
    const all = siblings.every((i) => (i.id === itemId ? ready : i.ready));
    const cond = and(eq(s.kitchenTickets.orderId, row.o.id), row.it.stationId ? eq(s.kitchenTickets.stationId, row.it.stationId) : isNull(s.kitchenTickets.stationId));
    if (all) await tx.update(s.kitchenTickets).set({ status: "READY", readyAt: new Date() }).where(cond);
    else await tx.update(s.kitchenTickets).set({ status: "PREPARING", startedAt: sql`coalesce(${s.kitchenTickets.startedAt}, now())`, readyAt: null }).where(and(cond, ne(s.kitchenTickets.status, "COMPLETED")));
    await syncOrderFromTickets(tx, row.o.id, actor);
    return row.o.id;
  });
  const full = await broadcast(orderId, actor.rid, "kitchen:order_received");
  emitTo([rooms.order(orderId), rooms.staff(actor.rid)], "order:item_updated", { orderId, itemId, ready });
  return full;
}

export async function kitchenQueue(rid: string, stationId?: string) {
  const rows = await db.select({ t: s.kitchenTickets, o: s.orders, st: s.kitchenStations, tn: s.cafeTables.number }).from(s.kitchenTickets)
    .innerJoin(s.orders, eq(s.orders.id, s.kitchenTickets.orderId)).innerJoin(s.cafeTables, eq(s.cafeTables.id, s.orders.tableId))
    .leftJoin(s.kitchenStations, eq(s.kitchenStations.id, s.kitchenTickets.stationId))
    .where(and(eq(s.orders.restaurantId, rid), inArray(s.orders.status, ["SENT_TO_KITCHEN", "PREPARING", "READY"]), ne(s.kitchenTickets.status, "COMPLETED"), ...(stationId ? [eq(s.kitchenTickets.stationId, stationId)] : [])))
    .orderBy(s.orders.createdAt);
  const items = rows.length ? await db.select().from(s.orderItems).where(inArray(s.orderItems.orderId, [...new Set(rows.map((r) => r.o.id))])) : [];
  return rows.map((r) => {
    const its = items.filter((i) => i.orderId === r.o.id && (i.stationId ?? null) === (r.t.stationId ?? null));
    const expected = Math.max(10, ...its.map(() => r.o.etaMinutes));
    const elapsedMin = (Date.now() - r.o.createdAt.getTime()) / 60000;
    return { ticket: r.t, order: { id: r.o.id, orderNumber: r.o.orderNumber, status: r.o.status, notes: r.o.notes, createdAt: r.o.createdAt }, station: r.st, tableNumber: r.tn, items: its, expectedMinutes: expected, elapsedMinutes: Math.round(elapsedMin * 10) / 10, overdue: elapsedMin > expected, priority: r.t.priority };
  });
}
