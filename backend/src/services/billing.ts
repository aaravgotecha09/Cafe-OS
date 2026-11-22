import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, schema as s, Executor } from "../db";
import { bad, conflict, notFound } from "../utils/errors";
import { emitTo, rooms } from "../sockets";
import { awardForOrder, reverseForOrder } from "./loyalty";
import { createProviderOrder, providerRefund, verifyProviderPayment } from "./gateway";
import { notify } from "./notify";
import { sendReceiptEmail } from "./receipt";

const LIVE = ["CANCELLED", "REJECTED"] as const;

export async function ensureBill(rid: string, tableSessionId: string) {
  return db.transaction(async (tx) => {
    const orders = await tx.select().from(s.orders).where(and(eq(s.orders.tableSessionId, tableSessionId), eq(s.orders.restaurantId, rid), notInArray(s.orders.status, [...LIVE])));
    if (!orders.length) throw bad("No orders to bill");
    const sum = (k: "subtotal" | "discount" | "tax" | "serviceCharge" | "total") => orders.reduce((a, o) => a + o[k], 0);
    const vals = { subtotal: sum("subtotal"), discount: sum("discount"), tax: sum("tax"), serviceCharge: sum("serviceCharge"), total: sum("total") };
    const [existing] = await tx.select().from(s.bills).where(eq(s.bills.tableSessionId, tableSessionId)).for("update");
    if (!existing) { const [b] = await tx.insert(s.bills).values({ restaurantId: rid, tableSessionId, ...vals }).returning(); return b; }
    if (existing.paidAmount > 0) return existing; // totals frozen once money has been collected
    const [b] = await tx.update(s.bills).set(vals).where(eq(s.bills.id, existing.id)).returning();
    return b;
  });
}
export async function billDetail(rid: string, tableSessionId: string) {
  const [bill] = await db.select().from(s.bills).where(and(eq(s.bills.tableSessionId, tableSessionId), eq(s.bills.restaurantId, rid)));
  if (!bill) return null;
  const [orders, splits, payments] = await Promise.all([
    db.select().from(s.orders).where(and(eq(s.orders.tableSessionId, tableSessionId), notInArray(s.orders.status, [...LIVE]))),
    db.select().from(s.billSplits).where(eq(s.billSplits.billId, bill.id)),
    db.select().from(s.payments).where(eq(s.payments.billId, bill.id)),
  ]);
  const items = orders.length ? await db.select().from(s.orderItems).where(inArray(s.orderItems.orderId, orders.map((o) => o.id))) : [];
  const tips = payments.filter((p) => p.status === "PAID").reduce((a, p) => a + p.tip, 0);
  return { ...bill, remaining: bill.total - bill.paidAmount, tips, orders, items, splits, payments };
}

type SplitInput = { mode: "equal"; people: number } | { mode: "items"; assignments: { label: string; itemIds: string[] }[] } | { mode: "custom"; parts: { label: string; amount: number }[] };
export async function createSplits(rid: string, tableSessionId: string, input: SplitInput) {
  const bill = await ensureBill(rid, tableSessionId);
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(s.bills).where(eq(s.bills.id, bill.id)).for("update");
    if (b.paidAmount > 0) throw conflict("Cannot change split after a payment has been made");
    const pending = await tx.select().from(s.payments).where(and(eq(s.payments.billId, b.id), eq(s.payments.status, "PENDING")));
    if (pending.length) await tx.update(s.payments).set({ status: "FAILED" }).where(inArray(s.payments.id, pending.map((p) => p.id)));
    await tx.delete(s.billSplits).where(eq(s.billSplits.billId, b.id));
    let parts: { label: string; amount: number; itemIds: string[] }[] = [];
    if (input.mode === "equal") {
      if (input.people < 1 || input.people > 20) throw bad("Invalid number of people");
      const base = Math.floor(b.total / input.people); const rem = b.total - base * input.people;
      parts = Array.from({ length: input.people }, (_, i) => ({ label: `Diner ${i + 1}`, amount: base + (i < rem ? 1 : 0), itemIds: [] }));
    } else if (input.mode === "custom") {
      if (input.parts.some((p) => p.amount <= 0)) throw bad("Amounts must be positive");
      if (input.parts.reduce((a, p) => a + p.amount, 0) !== b.total) throw bad(`Custom amounts must add up to the bill total (${b.total / 100})`);
      parts = input.parts.map((p) => ({ ...p, itemIds: [] }));
    } else {
      const orders = await tx.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.tableSessionId, tableSessionId), notInArray(s.orders.status, [...LIVE])));
      const items = await tx.select().from(s.orderItems).where(inArray(s.orderItems.orderId, orders.map((o) => o.id)));
      const assigned = input.assignments.flatMap((a) => a.itemIds);
      if (new Set(assigned).size !== assigned.length) throw bad("An item is assigned to more than one diner");
      if (assigned.length !== items.length || items.some((i) => !assigned.includes(i.id))) throw bad("Every item must be assigned to a diner");
      let used = 0;
      parts = input.assignments.map((a, idx) => {
        const lt = a.itemIds.reduce((n, id) => n + items.find((i) => i.id === id)!.lineTotal, 0);
        const amount = idx === input.assignments.length - 1 ? b.total - used : Math.round((lt / b.subtotal) * b.total); // taxes/discounts shared proportionally
        used += amount; return { label: a.label, amount, itemIds: a.itemIds };
      });
      if (parts.some((p) => p.amount <= 0)) throw bad("Every diner must have at least one item");
    }
    const rows = await tx.insert(s.billSplits).values(parts.map((p) => ({ billId: b.id, label: p.label, amount: p.amount, itemIds: p.itemIds }))).returning();
    return rows;
  });
}

export async function initiatePayment(rid: string, p: { tableSessionId: string; splitId?: string; method: (typeof s.paymentMethodEnum.enumValues)[number]; tipPercent?: number; tipAmount?: number; idempotencyKey: string; collectedBy?: string; customerSessionId?: string }) {
  const bill = await ensureBill(rid, p.tableSessionId);
  const out = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(s.bills).where(eq(s.bills.id, bill.id)).for("update");
    if (b.status === "PAID") throw conflict("Bill already paid");
    const [dupe] = await tx.select().from(s.payments).where(and(eq(s.payments.billId, b.id), eq(s.payments.idempotencyKey, p.idempotencyKey)));
    if (dupe) return { payment: dupe, created: false };
    let amount = b.total - b.paidAmount; let splitId: string | null = null;
    const splits = await tx.select().from(s.billSplits).where(eq(s.billSplits.billId, b.id));
    if (p.splitId) {
      const sp = splits.find((x) => x.id === p.splitId);
      if (!sp) throw notFound("Split not found");
      if (sp.paid) throw conflict("This share is already paid");
      const [open] = await tx.select().from(s.payments).where(and(eq(s.payments.splitId, sp.id), eq(s.payments.status, "PENDING")));
      if (open && open.method === p.method && !p.collectedBy) return { payment: open, created: false };
      amount = sp.amount; splitId = sp.id;
    } else if (splits.length) throw bad("This bill is split — choose a share to pay");
    if (amount <= 0) throw conflict("Nothing left to pay");
    if (amount > b.total - b.paidAmount) throw conflict("Amount exceeds the remaining balance");
    const tip = p.tipAmount != null ? p.tipAmount : Math.round((amount * (p.tipPercent || 0)) / 100);
    if (tip < 0 || tip > amount) throw bad("Invalid tip");
    let prov = { provider: "cash", providerOrderId: null as string | null, testMode: false };
    if (p.method !== "CASH") prov = (await createProviderOrder(amount + tip, `bill_${b.id.slice(0, 8)}`)) as any;
    const [payment] = await tx.insert(s.payments).values({ restaurantId: rid, billId: b.id, splitId, amount, tip, method: p.method, provider: prov.provider, providerOrderId: prov.providerOrderId, testMode: prov.testMode, idempotencyKey: p.idempotencyKey, collectedBy: p.collectedBy ?? null }).returning();
    return { payment, created: true };
  });
  if (out.created && out.payment.method === "CASH") { await finalize(out.payment.id, rid); }
  return out.payment;
}

/** Only call after server-side verification (signature/provider fetch/webhook/staff cash entry). */
export async function finalize(paymentId: string, rid: string) {
  const res = await db.transaction(async (tx) => {
    const [pay] = await tx.select().from(s.payments).where(and(eq(s.payments.id, paymentId), eq(s.payments.restaurantId, rid))).for("update");
    if (!pay) throw notFound("Payment not found");
    if (pay.status === "PAID") return { pay, bill: null as any, done: false };
    const [bill] = await tx.select().from(s.bills).where(eq(s.bills.id, pay.billId)).for("update");
    if (pay.status === "FAILED" || pay.status === "REFUNDED") throw conflict(`Payment is ${pay.status}`);
    if (bill.paidAmount + pay.amount > bill.total) { await tx.update(s.payments).set({ status: "FAILED" }).where(eq(s.payments.id, pay.id)); throw conflict("Payment would exceed bill total"); }
    await tx.update(s.payments).set({ status: "PAID", paidAt: new Date() }).where(eq(s.payments.id, pay.id));
    if (pay.splitId) await tx.update(s.billSplits).set({ paid: true }).where(eq(s.billSplits.id, pay.splitId));
    const paid = bill.paidAmount + pay.amount;
    const full = paid === bill.total;
    const [nb] = await tx.update(s.bills).set({ paidAmount: paid, status: full ? "PAID" : "OPEN" }).where(eq(s.bills.id, bill.id)).returning();
    if (full) {
      const orders = await tx.select().from(s.orders).where(and(eq(s.orders.tableSessionId, bill.tableSessionId), notInArray(s.orders.status, [...LIVE])));
      for (const o of orders) { await tx.update(s.orders).set({ paymentStatus: "PAID" }).where(eq(s.orders.id, o.id)); await awardForOrder(o.id, tx); }
      await settleSession(tx, rid, bill.tableSessionId);
    }
    return { pay: { ...pay, status: "PAID" as const }, bill: nb, done: full };
  });
  if (res.bill) {
    emitTo([rooms.staff(rid)], "payment:completed", { paymentId, billId: res.bill.id, paidAmount: res.bill.paidAmount, total: res.bill.total, done: res.done });
    const [ts] = await db.select().from(s.tableSessions).where(eq(s.tableSessions.id, res.bill.tableSessionId));
    if (ts) emitTo(rooms.table(rid, ts.tableId), "payment:completed", { paymentId, billId: res.bill.id, paidAmount: res.bill.paidAmount, total: res.bill.total, done: res.done });
    if (res.done) { await notify(rid, { role: "MANAGER", title: "Bill paid", body: `₹${res.bill.total / 100}`, kind: "payment" }); sendReceiptEmail(rid, res.bill.id).catch((e) => console.error("receipt email failed", e.message)); }
  }
  return res.pay;
}

/** Complete orders that are SERVED+PAID and close the table session once nothing is outstanding. */
export async function settleSession(tx: Executor, rid: string, tableSessionId: string) {
  const orders = await tx.select().from(s.orders).where(and(eq(s.orders.tableSessionId, tableSessionId), notInArray(s.orders.status, [...LIVE])));
  for (const o of orders) if (o.status === "SERVED" && o.paymentStatus === "PAID") {
    await tx.update(s.orders).set({ status: "COMPLETED", updatedAt: new Date() }).where(eq(s.orders.id, o.id));
    await tx.insert(s.orderStatusHistory).values({ orderId: o.id, status: "COMPLETED", note: "Paid & served" });
  }
  const fresh = await tx.select().from(s.orders).where(and(eq(s.orders.tableSessionId, tableSessionId), notInArray(s.orders.status, [...LIVE])));
  if (fresh.length && fresh.every((o) => o.status === "COMPLETED")) {
    const [ts] = await tx.update(s.tableSessions).set({ closedAt: new Date() }).where(and(eq(s.tableSessions.id, tableSessionId), sql`${s.tableSessions.closedAt} is null`)).returning();
    if (ts) { await tx.update(s.cafeTables).set({ status: "CLEANING" }).where(eq(s.cafeTables.id, ts.tableId)); emitTo(rooms.staff(rid), "table:status_updated", { tableId: ts.tableId, status: "CLEANING" }); }
  }
}

export async function verifyAndFinalize(rid: string, paymentId: string, tableSessionId: string | null, providerPaymentId: string, signature: string) {
  const [pay] = await db.select().from(s.payments).where(and(eq(s.payments.id, paymentId), eq(s.payments.restaurantId, rid)));
  if (!pay || !pay.providerOrderId) throw notFound("Payment not found");
  const [bill] = await db.select().from(s.bills).where(eq(s.bills.id, pay.billId));
  if (tableSessionId && bill.tableSessionId !== tableSessionId) throw notFound("Payment not found");
  if (pay.status === "PAID") return pay;
  try { await verifyProviderPayment({ providerOrderId: pay.providerOrderId, testMode: pay.testMode, amountPaise: pay.amount + pay.tip }, providerPaymentId, signature); }
  catch (e) {
    // A bad signature is rejected but leaves the payment PENDING: only the provider (webhook) may mark it FAILED,
    // otherwise any diner could sabotage another diner's in-flight payment.
    const [ts] = await db.select().from(s.tableSessions).where(eq(s.tableSessions.id, bill.tableSessionId));
    if (ts) emitTo(rooms.table(rid, ts.tableId), "payment:failed", { paymentId: pay.id });
    throw e;
  }
  await db.update(s.payments).set({ providerPaymentId }).where(eq(s.payments.id, pay.id));
  return finalize(pay.id, rid);
}

export async function refundPayment(rid: string, paymentId: string, amount: number | undefined, reason: string, userId: string) {
  const [pay] = await db.select().from(s.payments).where(and(eq(s.payments.id, paymentId), eq(s.payments.restaurantId, rid)));
  if (!pay) throw notFound("Payment not found");
  if (!["PAID", "PARTIALLY_REFUNDED"].includes(pay.status)) throw conflict("Only paid payments can be refunded");
  const prev = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, pay.id));
  const refundable = pay.amount + pay.tip - prev.reduce((a, r) => a + r.amount, 0);
  const amt = amount ?? refundable;
  if (amt <= 0 || amt > refundable) throw bad(`Refund must be between 1 and ${refundable}`);
  const pid = pay.method === "CASH" ? `cash_refund_${Date.now()}` : await providerRefund(pay.providerPaymentId || "", amt, pay.testMode);
  await db.transaction(async (tx) => {
    await tx.insert(s.refunds).values({ paymentId: pay.id, amount: amt, reason, providerRefundId: pid });
    const fully = amt === refundable;
    await tx.update(s.payments).set({ status: fully ? "REFUNDED" : "PARTIALLY_REFUNDED" }).where(eq(s.payments.id, pay.id));
    const [bill] = await tx.select().from(s.bills).where(eq(s.bills.id, pay.billId));
    const orders = await tx.select().from(s.orders).where(eq(s.orders.tableSessionId, bill.tableSessionId));
    if (fully) for (const o of orders) { await tx.update(s.orders).set({ paymentStatus: "REFUNDED" }).where(eq(s.orders.id, o.id)); await reverseForOrder(o.id, tx); }
    await tx.insert(s.auditLogs).values({ restaurantId: rid, userId, action: "payment.refund", entity: "payment", entityId: pay.id, meta: { amount: amt, reason } });
  });
  return { paymentId: pay.id, refunded: amt };
}
