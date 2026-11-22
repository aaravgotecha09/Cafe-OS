import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db, schema as s } from "../db";
import { ah, ok, parse } from "../utils/http";
import { bad, conflict, forbidden, notFound } from "../utils/errors";
import { randomToken, sha256, verifyQr } from "../utils/crypto";
import { requireCustomer } from "../middleware/auth";
import { cartLineSchema, evaluateCoupon, priceCart } from "../services/pricing";
import { createOrder, loadOrder } from "../services/orders";
import { billDetail, createSplits, ensureBill, initiatePayment, verifyAndFinalize } from "../services/billing";
import { gatewayInfo, testGatewayPay } from "../services/gateway";
import { buildReceiptPdf, sendReceiptEmail } from "../services/receipt";
import { addPoints, getOrCreateAccount, getRules } from "../services/loyalty";
import { emitTo, rooms } from "../sockets";
import { notify } from "../services/notify";
import { gamesRouter } from "./games";
import { publicRouter } from "./public";

export const customerRouter = Router();
customerRouter.use("/", publicRouter);

// ---- QR → table session ----
customerRouter.post("/qr/resolve", ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10), displayName: z.string().max(40).optional(), sessionToken: z.string().optional() }), req.body);
  const p = verifyQr(b.token);
  if (!p) throw bad("Invalid QR code");
  const [table] = await db.select().from(s.cafeTables).where(and(eq(s.cafeTables.id, p.t), eq(s.cafeTables.restaurantId, p.r)));
  if (!table || table.qrNonce !== p.n) throw bad("This QR code is no longer valid");
  const [rest] = await db.select().from(s.restaurants).where(eq(s.restaurants.id, table.restaurantId));
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${table.id}))`); // serialize concurrent scans of one table
    let [ts] = await tx.select().from(s.tableSessions).where(and(eq(s.tableSessions.tableId, table.id), isNull(s.tableSessions.closedAt)));
    if (!ts) { [ts] = await tx.insert(s.tableSessions).values({ restaurantId: table.restaurantId, tableId: table.id }).returning(); }
    if (b.sessionToken) {
      const [cs] = await tx.select().from(s.customerSessions).where(and(eq(s.customerSessions.tokenHash, sha256(b.sessionToken)), eq(s.customerSessions.tableSessionId, ts.id)));
      if (cs) return { ts, cs, token: b.sessionToken };
    }
    const token = randomToken(24);
    const [cs] = await tx.insert(s.customerSessions).values({ tableSessionId: ts.id, tokenHash: sha256(token), displayName: b.displayName ?? null }).returning();
    return { ts, cs, token };
  });
  if (table.status === "AVAILABLE") { await db.update(s.cafeTables).set({ status: "OCCUPIED" }).where(eq(s.cafeTables.id, table.id)); emitTo(rooms.staff(table.restaurantId), "table:status_updated", { tableId: table.id, status: "OCCUPIED" }); }
  ok(res, { sessionToken: out.token, sessionId: out.cs.id, tableSessionId: out.ts.id, table: { id: table.id, number: table.number, capacity: table.capacity }, restaurant: { id: rest.id, name: rest.name, slug: rest.slug, logoUrl: rest.logoUrl, currency: rest.currency } });
}));

customerRouter.get("/session", requireCustomer, ah(async (req, res) => {
  const c = req.cust!;
  const [t] = await db.select().from(s.cafeTables).where(eq(s.cafeTables.id, c.tableId));
  const [r] = await db.select().from(s.restaurants).where(eq(s.restaurants.id, c.rid));
  const orders = await db.select().from(s.orders).where(and(eq(s.orders.tableSessionId, c.tableSessionId), eq(s.orders.customerSessionId, c.sessionId))).orderBy(desc(s.orders.createdAt));
  const customer = c.customerId ? (await db.select().from(s.customers).where(eq(s.customers.id, c.customerId)))[0] : null;
  ok(res, { table: { id: t.id, number: t.number }, restaurant: { id: r.id, name: r.name, logoUrl: r.logoUrl }, displayName: c.displayName, customer, orders, taxPercent: r.taxPercent, serviceChargePercent: r.serviceChargePercent });
}));

// ---- identify (optional, unlocks loyalty) ----
customerRouter.post("/customer/identify", requireCustomer, ah(async (req, res) => {
  const c = req.cust!;
  const b = parse(z.object({ name: z.string().min(1).max(60), phone: z.string().regex(/^\+?[0-9]{10,13}$/), email: z.string().email().optional(), birthday: z.string().regex(/^\d{2}-\d{2}$/).optional(), consent: z.boolean().default(false), referralCode: z.string().optional() }), req.body);
  const result = await db.transaction(async (tx) => {
    let [cu] = await tx.select().from(s.customers).where(and(eq(s.customers.restaurantId, c.rid), eq(s.customers.phone, b.phone)));
    let isNew = false;
    if (!cu) {
      isNew = true;
      let referrer: typeof s.customers.$inferSelect | undefined;
      if (b.referralCode) [referrer] = await tx.select().from(s.customers).where(and(eq(s.customers.restaurantId, c.rid), eq(s.customers.referralCode, b.referralCode.toUpperCase())));
      [cu] = await tx.insert(s.customers).values({ restaurantId: c.rid, name: b.name, phone: b.phone, email: b.email, birthday: b.birthday, consentPersonalization: b.consent, referralCode: randomToken(3).toUpperCase(), referredBy: referrer?.id }).returning();
      await getOrCreateAccount(c.rid, cu.id, tx);
      if (referrer) { const rules = await getRules(c.rid, tx); await addPoints(c.rid, referrer.id, rules.referralBonus, "REFERRAL", `ref:${cu.id}`, `Referred ${b.name}`, tx); await addPoints(c.rid, cu.id, rules.referralBonus, "REFERRAL", `refd:${cu.id}`, "Welcome bonus", tx); }
    } else if (b.email && !cu.email) [cu] = await tx.update(s.customers).set({ email: b.email }).where(eq(s.customers.id, cu.id)).returning();
    await tx.update(s.customerSessions).set({ customerId: cu.id, displayName: cu.name }).where(eq(s.customerSessions.id, c.sessionId));
    return { cu, isNew };
  });
  ok(res, result.cu);
}));

// ---- cart / orders ----
const cartBody = z.object({ lines: z.array(cartLineSchema).min(1), couponCode: z.string().optional(), redeemPoints: z.number().int().min(0).optional() });
customerRouter.post("/cart/price", requireCustomer, ah(async (req, res) => {
  const b = parse(cartBody, req.body);
  const p = await priceCart(req.cust!.rid, b.lines, { couponCode: b.couponCode, customerId: req.cust!.customerId, redeemPoints: b.redeemPoints });
  ok(res, p);
}));
customerRouter.post("/coupons/validate", requireCustomer, ah(async (req, res) => {
  const b = parse(cartBody.pick({ lines: true, couponCode: true }).required({ couponCode: true }), req.body);
  ok(res, await priceCart(req.cust!.rid, b.lines, { couponCode: b.couponCode, customerId: req.cust!.customerId }));
}));
customerRouter.post("/orders", requireCustomer, ah(async (req, res) => {
  const c = req.cust!;
  const b = parse(cartBody.extend({ notes: z.string().max(500).optional(), customerName: z.string().max(60).optional() }), req.body);
  ok(res, await createOrder({ rid: c.rid, tableId: c.tableId, tableSessionId: c.tableSessionId, sessionId: c.sessionId, customerId: c.customerId }, b), 201);
}));
customerRouter.get("/orders", requireCustomer, ah(async (req, res) => {
  const c = req.cust!;
  const mine = req.query.scope === "table" ? [] : [eq(s.orders.customerSessionId, c.sessionId)];
  ok(res, await db.select().from(s.orders).where(and(eq(s.orders.tableSessionId, c.tableSessionId), ...mine)).orderBy(desc(s.orders.createdAt)));
}));
customerRouter.get("/orders/:id", requireCustomer, ah(async (req, res) => {
  const o = await loadOrder(String(req.params.id), req.cust!.rid);
  if (!o || o.tableSessionId !== req.cust!.tableSessionId) throw notFound("Order not found");
  ok(res, o);
}));

// ---- assistance ----
customerRouter.post("/requests", requireCustomer, ah(async (req, res) => {
  const c = req.cust!;
  const b = parse(z.object({ type: z.enum(s.requestTypeEnum.enumValues), message: z.string().max(200).optional() }), req.body);
  if (b.type === "CUSTOM" && !b.message) throw bad("Please describe your request");
  const [active] = await db.select().from(s.serviceRequests).where(and(eq(s.serviceRequests.tableId, c.tableId), eq(s.serviceRequests.type, b.type), notInArray(s.serviceRequests.status, ["COMPLETED"])));
  if (active) throw conflict("This request is already on its way");
  const [recent] = await db.select().from(s.serviceRequests).where(and(eq(s.serviceRequests.tableId, c.tableId), eq(s.serviceRequests.type, b.type), gte(s.serviceRequests.completedAt, new Date(Date.now() - 60_000))));
  if (recent) return res.status(429).json({ success: false, error: { code: "COOLDOWN", message: "Please wait a minute before requesting this again" } });
  const [r] = await db.insert(s.serviceRequests).values({ restaurantId: c.rid, tableId: c.tableId, tableSessionId: c.tableSessionId, type: b.type, message: b.message }).returning();
  const [t] = await db.select().from(s.cafeTables).where(eq(s.cafeTables.id, c.tableId));
  emitTo(rooms.staff(c.rid), "waiter:service_requested", { ...r, tableNumber: t.number });
  await notify(c.rid, { role: "WAITER", title: `Table ${t.number}: ${b.type.replace("_", " ")}`, body: b.message, kind: "request" });
  ok(res, r, 201);
}));
customerRouter.get("/requests", requireCustomer, ah(async (req, res) => {
  ok(res, await db.select().from(s.serviceRequests).where(eq(s.serviceRequests.tableSessionId, req.cust!.tableSessionId)).orderBy(desc(s.serviceRequests.createdAt)));
}));

// ---- wifi (only what admin configured) ----
customerRouter.get("/wifi", requireCustomer, ah(async (req, res) => {
  const [r] = await db.select({ settings: s.restaurants.settings }).from(s.restaurants).where(eq(s.restaurants.id, req.cust!.rid));
  const w = (r.settings as any)?.wifi;
  if (!w?.ssid) throw notFound("Wi-Fi details have not been configured");
  const esc = (x: string) => x.replace(/([\\;,:"])/g, "\\$1");
  ok(res, { ssid: w.ssid, password: w.password || "", security: w.security || "WPA", instructions: w.instructions || "Open Wi-Fi settings, choose the network and enter the password.", qrPayload: `WIFI:T:${w.password ? w.security || "WPA" : "nopass"};S:${esc(w.ssid)};P:${esc(w.password || "")};;` });
}));

// ---- loyalty ----
customerRouter.get("/loyalty", requireCustomer, ah(async (req, res) => {
  const c = req.cust!; if (!c.customerId) return ok(res, { identified: false });
  const acc = await getOrCreateAccount(c.rid, c.customerId);
  const [cu] = await db.select().from(s.customers).where(eq(s.customers.id, c.customerId));
  const history = await db.select().from(s.loyaltyTransactions).where(eq(s.loyaltyTransactions.accountId, acc.id)).orderBy(desc(s.loyaltyTransactions.createdAt)).limit(50);
  const rules = await getRules(c.rid);
  const next = acc.tier === "BRONZE" ? ["SILVER", rules.tiers.SILVER] : acc.tier === "SILVER" ? ["GOLD", rules.tiers.GOLD] : acc.tier === "GOLD" ? ["PLATINUM", rules.tiers.PLATINUM] : null;
  ok(res, { identified: true, account: acc, history, referralCode: cu.referralCode, rules: { pointValuePaise: rules.pointValuePaise, pointsPerRupee: rules.pointsPerRupee }, nextTier: next && { name: next[0], pointsNeeded: Math.max(0, (next[1] as number) - acc.lifetimePoints) } });
}));
customerRouter.post("/loyalty/birthday", requireCustomer, ah(async (req, res) => {
  const c = req.cust!; if (!c.customerId) throw bad("Identify yourself first");
  const [cu] = await db.select().from(s.customers).where(eq(s.customers.id, c.customerId));
  const mmdd = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit" }).split("/").reverse().join("-");
  if (cu.birthday !== mmdd) throw bad("Birthday reward is available only on your birthday");
  const rules = await getRules(c.rid);
  const year = new Date().getFullYear();
  const added = await db.transaction((tx) => addPoints(c.rid, cu.id, rules.birthdayBonus, "BIRTHDAY", `bday:${year}`, "Happy birthday!", tx));
  if (!added) throw conflict("Birthday reward already claimed this year");
  ok(res, { points: rules.birthdayBonus });
}));
customerRouter.get("/offers", requireCustomer, ah(async (req, res) => {
  const now = new Date();
  const list = await db.select().from(s.coupons).where(and(eq(s.coupons.restaurantId, req.cust!.rid), eq(s.coupons.active, true)));
  ok(res, list.filter((c) => (!c.startsAt || c.startsAt <= now) && (!c.endsAt || c.endsAt >= now)).map((c) => ({ code: c.code, type: c.type, value: c.value, minOrder: c.minOrder, maxDiscount: c.maxDiscount, firstOrderOnly: c.firstOrderOnly, minTier: c.minTier })));
}));
customerRouter.get("/history", requireCustomer, ah(async (req, res) => {
  const c = req.cust!; if (!c.customerId) return ok(res, { identified: false, orders: [], favourites: [], reviews: [] });
  const orders = await db.select().from(s.orders).where(eq(s.orders.customerId, c.customerId)).orderBy(desc(s.orders.createdAt)).limit(50);
  const items = orders.length ? await db.select().from(s.orderItems).where(inArray(s.orderItems.orderId, orders.map((o) => o.id))) : [];
  const reviews = await db.select().from(s.reviews).where(eq(s.reviews.customerId, c.customerId));
  const [cu] = await db.select().from(s.customers).where(eq(s.customers.id, c.customerId));
  const reservations = cu.phone ? await db.select().from(s.reservations).where(and(eq(s.reservations.restaurantId, c.rid), eq(s.reservations.phone, cu.phone))) : [];
  const counts = new Map<string, number>(); items.forEach((i) => counts.set(i.productId, (counts.get(i.productId) || 0) + i.quantity));
  ok(res, { identified: true, orders, reviews, reservations, favourites: cu.favourites, previouslyOrdered: cu.consentPersonalization ? [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([productId, n]) => ({ productId, times: n })) : [] });
}));
customerRouter.post("/favourites/:productId", requireCustomer, ah(async (req, res) => {
  const c = req.cust!; if (!c.customerId) throw bad("Identify yourself first");
  const pid = String(req.params.productId);
  const [cu] = await db.select().from(s.customers).where(eq(s.customers.id, c.customerId));
  const fav = new Set(cu.favourites as string[]); if (fav.has(pid)) fav.delete(pid); else fav.add(pid);
  await db.update(s.customers).set({ favourites: [...fav] }).where(eq(s.customers.id, cu.id));
  ok(res, [...fav]);
}));

// ---- reviews: verified, completed orders only, one per order ----
customerRouter.post("/reviews", requireCustomer, ah(async (req, res) => {
  const c = req.cust!;
  const b = parse(z.object({ orderId: z.string().uuid(), food: z.number().int().min(1).max(5), service: z.number().int().min(1).max(5), ambience: z.number().int().min(1).max(5), cleanliness: z.number().int().min(1).max(5).optional(), overall: z.number().int().min(1).max(5), comment: z.string().max(1000).optional(), photoUrl: z.string().url().optional() }), req.body);
  const [o] = await db.select().from(s.orders).where(and(eq(s.orders.id, b.orderId), eq(s.orders.restaurantId, c.rid)));
  if (!o || o.customerSessionId !== c.sessionId) throw forbidden("You can only review your own orders");
  if (o.status !== "COMPLETED" || o.paymentStatus !== "PAID") throw bad("You can review once your order is completed and paid");
  const [dupe] = await db.select().from(s.reviews).where(eq(s.reviews.orderId, o.id));
  if (dupe) throw conflict("You have already reviewed this order");
  const [r] = await db.insert(s.reviews).values({ restaurantId: c.rid, customerId: o.customerId, ...b }).returning();
  ok(res, r, 201);
}));

// ---- billing ----
customerRouter.post("/billing/request", requireCustomer, ah(async (req, res) => {
  const c = req.cust!;
  const bill = await ensureBill(c.rid, c.tableSessionId);
  const [t] = await db.select().from(s.cafeTables).where(eq(s.cafeTables.id, c.tableId));
  const [active] = await db.select().from(s.serviceRequests).where(and(eq(s.serviceRequests.tableId, c.tableId), eq(s.serviceRequests.type, "BILL"), notInArray(s.serviceRequests.status, ["COMPLETED"])));
  if (!active) { const [r] = await db.insert(s.serviceRequests).values({ restaurantId: c.rid, tableId: c.tableId, tableSessionId: c.tableSessionId, type: "BILL" }).returning(); emitTo(rooms.staff(c.rid), "waiter:service_requested", { ...r, tableNumber: t.number }); }
  ok(res, await billDetail(c.rid, c.tableSessionId));
}));
customerRouter.get("/billing", requireCustomer, ah(async (req, res) => {
  await ensureBill(req.cust!.rid, req.cust!.tableSessionId);
  ok(res, await billDetail(req.cust!.rid, req.cust!.tableSessionId));
}));
customerRouter.post("/billing/split", requireCustomer, ah(async (req, res) => {
  const b = parse(z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("equal"), people: z.number().int().min(1).max(20) }),
    z.object({ mode: z.literal("items"), assignments: z.array(z.object({ label: z.string().min(1).max(40), itemIds: z.array(z.string().uuid()).min(1) })).min(1) }),
    z.object({ mode: z.literal("custom"), parts: z.array(z.object({ label: z.string().min(1).max(40), amount: z.number().int().positive() })).min(1) }),
  ]), req.body);
  await createSplits(req.cust!.rid, req.cust!.tableSessionId, b);
  const d = await billDetail(req.cust!.rid, req.cust!.tableSessionId);
  emitTo(rooms.table(req.cust!.rid, req.cust!.tableId), "table:status_updated", { tableId: req.cust!.tableId, billUpdated: true });
  ok(res, d);
}));
customerRouter.get("/payments/config", ah(async (_req, res) => ok(res, gatewayInfo())));
customerRouter.post("/payments", requireCustomer, ah(async (req, res) => {
  const c = req.cust!;
  const b = parse(z.object({ splitId: z.string().uuid().optional(), method: z.enum(["UPI", "CARD", "NETBANKING", "WALLET", "ONLINE"]), tipPercent: z.number().min(0).max(100).optional(), tipAmount: z.number().int().min(0).optional(), idempotencyKey: z.string().min(8).max(80) }), req.body);
  const p = await initiatePayment(c.rid, { tableSessionId: c.tableSessionId, ...b, customerSessionId: c.sessionId });
  ok(res, { payment: p, gateway: gatewayInfo(), amountPayable: p.amount + p.tip }, 201);
}));
/** TEST MODE ONLY: stand-in for the Razorpay checkout; returns a server-signed id that /payments/verify checks. */
customerRouter.post("/payments/:id/test-checkout", requireCustomer, ah(async (req, res) => {
  const [p] = await db.select().from(s.payments).innerJoin(s.bills, eq(s.bills.id, s.payments.billId)).where(and(eq(s.payments.id, String(req.params.id)), eq(s.bills.tableSessionId, req.cust!.tableSessionId)));
  if (!p || !p.payments.testMode || !p.payments.providerOrderId) throw notFound("Test payment not found");
  ok(res, testGatewayPay(p.payments.providerOrderId));
}));
customerRouter.post("/payments/:id/verify", requireCustomer, ah(async (req, res) => {
  const b = parse(z.object({ razorpay_payment_id: z.string(), razorpay_signature: z.string() }), req.body);
  const p = await verifyAndFinalize(req.cust!.rid, String(req.params.id), req.cust!.tableSessionId, b.razorpay_payment_id, b.razorpay_signature);
  ok(res, p);
}));
customerRouter.get("/receipts/:billId.pdf", requireCustomer, ah(async (req, res) => {
  const [bill] = await db.select().from(s.bills).where(and(eq(s.bills.id, String(req.params.billId)), eq(s.bills.tableSessionId, req.cust!.tableSessionId)));
  if (!bill) throw notFound("Bill not found");
  res.type("application/pdf").send(await buildReceiptPdf(req.cust!.rid, bill.id));
}));
customerRouter.post("/receipts/:billId/email", requireCustomer, ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().email() }), req.body);
  const [bill] = await db.select().from(s.bills).where(and(eq(s.bills.id, String(req.params.billId)), eq(s.bills.tableSessionId, req.cust!.tableSessionId)));
  if (!bill || bill.status !== "PAID") throw notFound("Paid bill not found");
  ok(res, await sendReceiptEmail(req.cust!.rid, bill.id, b.email));
}));

customerRouter.use("/games", requireCustomer, gamesRouter);
