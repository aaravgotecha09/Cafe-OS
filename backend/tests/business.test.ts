import { beforeAll, afterAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { api, auth, boot, cs, find, login, menu, scan, servedOrder, shutdown, staffTokens } from "./helpers";
import { db, schema as s } from "../src/db";

beforeAll(boot); afterAll(shutdown);
const pay = async (tok: string, body: object) => api().post("/api/payments").set(cs(tok)).send({ method: "UPI", idempotencyKey: crypto.randomUUID(), ...body });
const settle = async (tok: string, paymentId: string) => { const co = await api().post(`/api/payments/${paymentId}/test-checkout`).set(cs(tok)); return api().post(`/api/payments/${paymentId}/verify`).set(cs(tok)).send({ razorpay_payment_id: co.body.data.razorpay_payment_id, razorpay_signature: co.body.data.razorpay_signature }); };

describe("billing & split payments", () => {
  it("splits by items / custom amounts with exact totals and validates input", async () => {
    const { sess } = await servedOrder(1, ["Cappuccino", "Margherita Pizza", "Tiramisu"]);
    const b = (await api().post("/api/billing/request").set(cs(sess.sessionToken))).body.data; const ids = b.items.map((i: any) => i.id);
    expect((await api().post("/api/billing/split").set(cs(sess.sessionToken)).send({ mode: "items", assignments: [{ label: "A", itemIds: [ids[0]] }] })).status).toBe(400); // unassigned items
    expect((await api().post("/api/billing/split").set(cs(sess.sessionToken)).send({ mode: "items", assignments: [{ label: "A", itemIds: [ids[0], ids[1]] }, { label: "B", itemIds: [ids[1], ids[2]] }] })).status).toBe(400); // double-assigned
    const ok = await api().post("/api/billing/split").set(cs(sess.sessionToken)).send({ mode: "items", assignments: [{ label: "A", itemIds: [ids[0], ids[1]] }, { label: "B", itemIds: [ids[2]] }] }); expect(ok.status).toBe(200);
    expect(ok.body.data.splits.reduce((a: number, x: any) => a + x.amount, 0)).toBe(b.total);
    expect((await api().post("/api/billing/split").set(cs(sess.sessionToken)).send({ mode: "custom", parts: [{ label: "A", amount: 100 }, { label: "B", amount: 100 }] })).status).toBe(400);
    const cust = await api().post("/api/billing/split").set(cs(sess.sessionToken)).send({ mode: "custom", parts: [{ label: "A", amount: b.total - 5000 }, { label: "B", amount: 5000 }] }); expect(cust.status).toBe(200);
    expect((await pay(sess.sessionToken, {})).status).toBe(400); // split bill: must choose a share
    const sh = cust.body.data.splits[0]; const p1 = await pay(sess.sessionToken, { splitId: sh.id }); expect((await settle(sess.sessionToken, p1.body.data.payment.id)).status).toBe(200);
    expect((await pay(sess.sessionToken, { splitId: sh.id })).status).toBe(409); // share already paid
    expect((await api().post("/api/billing/split").set(cs(sess.sessionToken)).send({ mode: "equal", people: 3 })).status).toBe(409); // can't re-split after money collected
    const [t] = await db.select().from(s.cafeTables).where(eq(s.cafeTables.number, 1)); expect(t.status).toBe("OCCUPIED"); // not closed until fully paid
  });
  it("never collects more than the bill, even with concurrent payments", async () => {
    const { sess } = await servedOrder(2, ["Cappuccino"]);
    await api().post("/api/billing/request").set(cs(sess.sessionToken));
    const [a, b] = await Promise.all([pay(sess.sessionToken, {}), pay(sess.sessionToken, {})]); // two diners hit "pay full bill" together
    const ids = [a.body.data.payment.id, b.body.data.payment.id];
    const results = await Promise.all(ids.map((id) => settle(sess.sessionToken, id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const bill = (await api().get("/api/billing").set(cs(sess.sessionToken))).body.data; expect(bill.paidAmount).toBe(bill.total); expect(bill.status).toBe("PAID");
    expect(bill.payments.filter((p: any) => p.status === "PAID")).toHaveLength(1);
  });
  it("idempotency key returns the same payment; verifying twice does not double-count", async () => {
    const { sess } = await servedOrder(3, ["Masala Chai"]); await api().post("/api/billing/request").set(cs(sess.sessionToken));
    const key = crypto.randomUUID(); const a = await pay(sess.sessionToken, { idempotencyKey: key }); const b = await pay(sess.sessionToken, { idempotencyKey: key });
    expect(b.body.data.payment.id).toBe(a.body.data.payment.id);
    const co = await api().post(`/api/payments/${a.body.data.payment.id}/test-checkout`).set(cs(sess.sessionToken)); const body = { razorpay_payment_id: co.body.data.razorpay_payment_id, razorpay_signature: co.body.data.razorpay_signature };
    expect((await api().post(`/api/payments/${a.body.data.payment.id}/verify`).set(cs(sess.sessionToken)).send(body)).status).toBe(200);
    expect((await api().post(`/api/payments/${a.body.data.payment.id}/verify`).set(cs(sess.sessionToken)).send(body)).status).toBe(200);
    const bill = (await api().get("/api/billing").set(cs(sess.sessionToken))).body.data; expect(bill.paidAmount).toBe(bill.total);
    expect((await api().post(`/api/payments/${a.body.data.payment.id}/test-checkout`).set(cs((await scan(4)).sessionToken))).status).toBe(404); // other table can't touch it
  });
  it("blocks adding orders once payment has started", async () => {
    const { sess } = await servedOrder(4, ["Cappuccino", "Tiramisu"]); await api().post("/api/billing/request").set(cs(sess.sessionToken));
    const sp = await api().post("/api/billing/split").set(cs(sess.sessionToken)).send({ mode: "equal", people: 2 });
    await settle(sess.sessionToken, (await pay(sess.sessionToken, { splitId: sp.body.data.splits[0].id })).body.data.payment.id);
    const r = await api().post("/api/orders").set(cs(sess.sessionToken)).send({ lines: [{ productId: find(await menu(), "Peri Peri Fries").id, quantity: 1 }] }); expect(r.status).toBe(409);
  });
  it("cash payments are staff-only and finalize immediately; webhook is signature-verified", async () => {
    const st = await staffTokens(); const { sess } = await servedOrder(6, ["Americano"]); await api().post("/api/billing/request").set(cs(sess.sessionToken));
    expect((await api().post("/api/staff/billing/cash").set(auth(st.kitchen.accessToken)).send({ tableSessionId: sess.tableSessionId, idempotencyKey: "cash-key-1" })).status).toBe(403);
    // webhook for an online test payment on the same session would be ignored here; use a fresh table for the webhook path
    const w = await servedOrder(16, ["Flat White"]); await api().post("/api/billing/request").set(cs(w.sess.sessionToken));
    const p = await pay(w.sess.sessionToken, {}); const pid = p.body.data.payment.id; const [row] = await db.select().from(s.payments).where(eq(s.payments.id, pid));
    const evt = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_hook1", order_id: row.providerOrderId, amount: row.amount + row.tip } } } });
    expect((await api().post("/api/payments/webhook").set("Content-Type", "application/json").set("x-razorpay-signature", "bad").send(evt)).status).toBe(400);
    const sig = crypto.createHmac("sha256", "whsec_test").update(evt).digest("hex");
    expect((await api().post("/api/payments/webhook").set("Content-Type", "application/json").set("x-razorpay-signature", sig).send(evt)).status).toBe(200);
    const [after] = await db.select().from(s.payments).where(eq(s.payments.id, pid)); expect(after.status).toBe("PAID");
    expect((await api().post("/api/payments/webhook").set("Content-Type", "application/json").set("x-razorpay-signature", sig).send(evt)).status).toBe(200); // replay is harmless
    const [bill] = await db.select().from(s.bills).where(eq(s.bills.id, row.billId)); expect(bill.paidAmount).toBe(bill.total);
    // cash path (table 6)
    const c = await api().post("/api/staff/billing/cash").set(auth(st.cashier.accessToken)).send({ tableSessionId: sess.tableSessionId, idempotencyKey: "cash-key-2", tipAmount: 1000 }); expect(c.status).toBe(201);
    const bill2 = (await api().get(`/api/staff/billing/${sess.tableSessionId}`).set(auth(st.cashier.accessToken))).body.data; expect(bill2.status).toBe("PAID"); expect(bill2.tips).toBe(1000);
  });
});

describe("refunds & loyalty integrity", () => {
  it("awards points only for paid orders, and reverses them on refund", async () => {
    const st = await staffTokens(); const { sess, id } = await servedOrder(17, ["Creamy Alfredo Pasta"], { identify: true });
    expect((await api().get("/api/loyalty").set(cs(sess.sessionToken))).body.data.account.points).toBe(0); // unpaid → nothing
    await api().post("/api/billing/request").set(cs(sess.sessionToken)); const p = await pay(sess.sessionToken, {}); await settle(sess.sessionToken, p.body.data.payment.id);
    const loy = (await api().get("/api/loyalty").set(cs(sess.sessionToken))).body.data; expect(loy.account.points).toBeGreaterThan(0); const earned = loy.account.points;
    expect((await api().post(`/api/admin/payments/${p.body.data.payment.id}/refund`).set(auth(st.waiter.accessToken)).send({ reason: "x y" })).status).toBe(403);
    expect((await api().post(`/api/admin/payments/${p.body.data.payment.id}/refund`).set(auth(st.manager.accessToken)).send({ amount: 99999999, reason: "too much" })).status).toBe(400);
    const r = await api().post(`/api/admin/payments/${p.body.data.payment.id}/refund`).set(auth(st.manager.accessToken)).send({ reason: "Customer unhappy" }); expect(r.status).toBe(200);
    expect((await api().post(`/api/admin/payments/${p.body.data.payment.id}/refund`).set(auth(st.manager.accessToken)).send({ reason: "again" })).status).toBe(409);
    const after = (await api().get("/api/loyalty").set(cs(sess.sessionToken))).body.data; expect(after.account.points).toBe(0); expect(after.history.some((h: any) => h.kind === "REVERSAL" && h.points === -earned)).toBe(true);
    const [o] = await db.select().from(s.orders).where(eq(s.orders.id, id)); expect(o.paymentStatus).toBe("REFUNDED");
  });
  it("rejected/cancelled orders release coupons and redeemed points; no points earned", async () => {
    const st = await staffTokens(); const t = await scan(18); const p = await menu();
    await api().post("/api/customer/identify").set(cs(t.sessionToken)).send({ name: "Coupon Tester", phone: "+919811122233", consent: true });
    const brownie = find(p, "Chocolate Brownie with Ice Cream"); const line = [{ productId: brownie.id, quantity: 1 }];
    const first = await api().post("/api/orders").set(cs(t.sessionToken)).send({ lines: line, couponCode: "WELCOME10" }); expect(first.status).toBe(201); expect(first.body.data.discount).toBe(2300);
    expect((await api().post("/api/orders").set(cs(t.sessionToken)).send({ lines: line, couponCode: "WELCOME10" })).status).toBe(400); // first-order coupon is single-use
    expect((await api().post(`/api/staff/orders/${first.body.data.id}/status`).set(auth(st.waiter.accessToken)).send({ status: "REJECTED" })).status).toBe(400); // reason required
    expect((await api().post(`/api/staff/orders/${first.body.data.id}/status`).set(auth(st.waiter.accessToken)).send({ status: "REJECTED", note: "Out of stock" })).status).toBe(200);
    expect((await api().post("/api/orders").set(cs(t.sessionToken)).send({ lines: line, couponCode: "WELCOME10" })).status).toBe(201); // rejected order released the coupon: customer still has no real first order
  });
  it("redeems points at checkout and refunds them when the order is cancelled", async () => {
    const st = await staffTokens(); const t = await scan(19); const p = await menu();
    await api().post("/api/customer/identify").set(cs(t.sessionToken)).send({ name: "Priya Nair", phone: "+919800000001", consent: true }); // seeded customer with 640 pts
    const line = [{ productId: find(p, "Tiramisu").id, quantity: 1 }];
    const o = await api().post("/api/orders").set(cs(t.sessionToken)).send({ lines: line, redeemPoints: 50 }); expect(o.status).toBe(201); expect(o.body.data.discount).toBe(5000);
    expect((await api().get("/api/loyalty").set(cs(t.sessionToken))).body.data.account.points).toBe(590);
    expect((await api().post("/api/orders").set(cs(t.sessionToken)).send({ lines: line, redeemPoints: 100000 })).status).toBe(400);
    await api().post(`/api/staff/orders/${o.body.data.id}/status`).set(auth(st.waiter.accessToken)).send({ status: "CANCELLED" });
    expect((await api().get("/api/loyalty").set(cs(t.sessionToken))).body.data.account.points).toBe(640);
  });
  it("referral bonus is granted once", async () => {
    const a = await scan(20); const r = await api().post("/api/customer/identify").set(cs(a.sessionToken)).send({ name: "Newbie", phone: "+919822200001", referralCode: "PRIYA1" }); expect(r.status).toBe(200);
    expect((await api().get("/api/loyalty").set(cs(a.sessionToken))).body.data.account.points).toBe(100);
    const again = await api().post("/api/customer/identify").set(cs(a.sessionToken)).send({ name: "Newbie", phone: "+919822200001", referralCode: "PRIYA1" });
    expect((await api().get("/api/loyalty").set(cs(a.sessionToken))).body.data.account.points).toBe(100);
  });
});

describe("inventory", () => {
  it("auto-disables products at minimum stock, re-enables after restock, guards negatives, keeps an audit trail", async () => {
    const st = await staffTokens(); const inv = (await api().get("/api/admin/inventory").set(auth(st.manager.accessToken))).body.data; const dough = inv.find((i: any) => i.name === "Pizza dough");
    const adj = (delta: number) => api().post(`/api/admin/inventory/${dough.id}/adjust`).set(auth(st.manager.accessToken)).send({ delta, reason: "stock count" });
    expect((await adj(-999)).status).toBe(409);
    expect((await adj(-50)).status).toBe(200); // 60 → 10 = minimum
    const m = await menu(); expect(find(m, "Margherita Pizza")).toBeUndefined(); // hidden from customers
    const t = await scan(13); expect((await api().post("/api/orders").set(cs(t.sessionToken)).send({ lines: [{ productId: (await db.select().from(s.products).where(eq(s.products.name, "Margherita Pizza")))[0].id, quantity: 1 }] })).status).toBe(400);
    expect((await adj(+30)).status).toBe(200); expect(find(await menu(), "Margherita Pizza")).toBeTruthy();
    const mv = await api().get(`/api/admin/inventory/${dough.id}/movements`).set(auth(st.manager.accessToken)); expect(mv.body.data.length).toBeGreaterThanOrEqual(3);
    expect((await api().post(`/api/admin/inventory/${dough.id}/adjust`).set(auth(st.waiter.accessToken)).send({ delta: 1, reason: "x y" })).status).toBe(403);
  });
});

describe("games", () => {
  it("quizzes never expose answers, enforce one submission, and cap rewards", async () => {
    const t = await scan(8); await api().post("/api/customer/identify").set(cs(t.sessionToken)).send({ name: "Gamer", phone: "+919833300001" });
    const q = await api().post("/api/games/quiz/trivia/start").set(cs(t.sessionToken)); expect(q.body.data.questions).toHaveLength(5); expect(JSON.stringify(q.body.data)).not.toMatch(/"a":|answer/i);
    expect((await api().post(`/api/games/quiz/${q.body.data.id}/submit`).set(cs(t.sessionToken)).send({ answers: [0, 0, 0, 0, 0] })).status).toBe(400); // too quick
    await new Promise((r) => setTimeout(r, 3100));
    const sub = await api().post(`/api/games/quiz/${q.body.data.id}/submit`).set(cs(t.sessionToken)).send({ answers: [0, 0, 0, 0, 0] }); expect(sub.status).toBe(200); expect(sub.body.data.rewardPoints).toBeLessThanOrEqual(3);
    expect((await api().post(`/api/games/quiz/${q.body.data.id}/submit`).set(cs(t.sessionToken)).send({ answers: [0, 0, 0, 0, 0] })).status).toBe(409);
    const other = await scan(9); expect((await api().post(`/api/games/quiz/${q.body.data.id}/submit`).set(cs(other.sessionToken)).send({ answers: [0, 0, 0, 0, 0] })).status).toBe(404);
    expect((await api().post("/api/games/memory/score").set(cs(t.sessionToken)).send({ moves: 2, seconds: 1 })).status).toBe(400); // impossible score
    expect((await api().post("/api/games/spin").set(cs(t.sessionToken))).status).toBe(200); expect((await api().post("/api/games/spin").set(cs(t.sessionToken))).status).toBe(409);
    expect((await api().get("/api/games/leaderboard").set(cs(t.sessionToken))).status).toBe(200);
  });
  it("tic-tac-toe is server-authoritative between two diners / two tables", async () => {
    const a = await scan(10, "A"); const b = await scan(10, "B"); const c = await scan(11, "C");
    const g = (await api().post("/api/games/ttt").set(cs(a.sessionToken)).send({})).body.data;
    expect((await api().post(`/api/games/ttt/${g.id}/join`).set(cs(c.sessionToken))).status).toBe(403); // other table can't join a same-table game
    expect((await api().post(`/api/games/ttt/${g.id}/move`).set(cs(a.sessionToken)).send({ cell: 0 })).status).toBe(409); // no opponent yet
    expect((await api().post(`/api/games/ttt/${g.id}/join`).set(cs(b.sessionToken))).status).toBe(200);
    const mv = (tok: string, cell: number) => api().post(`/api/games/ttt/${g.id}/move`).set(cs(tok)).send({ cell });
    expect((await mv(b.sessionToken, 4)).status).toBe(409); // not B's turn
    await mv(a.sessionToken, 0); expect((await mv(b.sessionToken, 0)).status).toBe(400); await mv(b.sessionToken, 3); await mv(a.sessionToken, 1); await mv(b.sessionToken, 4);
    const fin = await mv(a.sessionToken, 2); expect(fin.body.data.winner).toBe("X"); expect((await mv(b.sessionToken, 5)).status).toBe(404);
    const ch = (await api().post("/api/games/ttt").set(cs(a.sessionToken)).send({ targetTable: 11 })).body.data;
    expect((await api().get("/api/games/ttt/open").set(cs(c.sessionToken))).body.data.some((x: any) => x.id === ch.id)).toBe(true); expect((await api().post(`/api/games/ttt/${ch.id}/join`).set(cs(c.sessionToken))).status).toBe(200);
  });
});

describe("reservations & waitlist", () => {
  it("books tables without double-booking, cancels by phone, runs a waitlist", async () => {
    const d = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const slots = (await api().get(`/api/reservations/slots?restaurant=orange-oak&date=${d}&party=6`)).body.data; expect(slots.length).toBeGreaterThan(10);
    const book = (i: number) => api().post("/api/reservations?restaurant=orange-oak").send({ name: `Guest ${i}`, phone: `+91990000000${i}`, partySize: 6, date: d, time: "19:00" });
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(book)); const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(5); // only 5 tables seat 6 — concurrent bookings can't exceed capacity
    expect(new Set(created.map((r) => r.body.data.tableId)).size).toBe(5);
    expect((await api().get(`/api/reservations/slots?restaurant=orange-oak&date=${d}&party=6`)).body.data.find((x: any) => x.time === "19:00").available).toBe(false);
    const r0 = created[0].body.data; expect((await api().post(`/api/reservations/${r0.id}/cancel`).send({ phone: "+910000000000" })).status).toBe(404);
    expect((await api().post(`/api/reservations/${r0.id}/cancel`).send({ phone: r0.phone })).status).toBe(200);
    expect((await api().post("/api/reservations?restaurant=orange-oak").send({ name: "Past", phone: "+919900000009", partySize: 2, date: "2020-01-01", time: "10:00" })).status).toBe(400);
    const w = await api().post("/api/waitlist?restaurant=orange-oak").send({ name: "Walk-in", partySize: 3 }); expect(w.status).toBe(201); expect(w.body.data.estimatedWaitMinutes).toBeGreaterThan(0);
    const st = await staffTokens(); expect((await api().post(`/api/staff/waitlist/${w.body.data.id}/notify`).set(auth(st.waiter.accessToken))).status).toBe(200);
    expect((await api().get(`/api/waitlist/${w.body.data.id}`)).body.data.status).toBe("NOTIFIED");
  });
});

describe("admin: menu, tables, staff, settings, analytics", () => {
  it("product CRUD with variants/customizations, soft-delete when ordered", async () => {
    const st = await staffTokens(); const cats = (await api().get("/api/admin/categories").set(auth(st.manager.accessToken))).body.data;
    const body = { categoryId: cats[0].id, name: "Test Brew", price: 25000, description: "x", allergens: ["Milk"], variants: [{ name: "S", priceDelta: 0, isDefault: true }, { name: "L", priceDelta: 3000 }], customizationGroups: [{ name: "Syrup", required: true, options: [{ name: "Vanilla", priceDelta: 2000 }] }] };
    expect((await api().post("/api/admin/products").set(auth(st.waiter.accessToken)).send(body)).status).toBe(403);
    expect((await api().post("/api/admin/products").set(auth(st.manager.accessToken)).send({ ...body, price: -1 })).status).toBe(400);
    expect((await api().post("/api/admin/products").set(auth(st.manager.accessToken)).send({ ...body, discountPrice: 99999999 })).status).toBe(400);
    const c = await api().post("/api/admin/products").set(auth(st.manager.accessToken)).send(body); expect(c.status).toBe(201);
    const pr = find(await menu(), "Test Brew"); expect(pr.variants).toHaveLength(2); expect(pr.customizationGroups[0].options[0].name).toBe("Vanilla");
    const u = await api().put(`/api/admin/products/${c.body.data.id}`).set(auth(st.manager.accessToken)).send({ ...body, name: "Test Brew 2", price: 27000, customizationGroups: [] }); expect(u.status).toBe(200); expect(find(await menu(), "Test Brew 2").price).toBe(27000);
    expect((await api().delete(`/api/admin/products/${c.body.data.id}`).set(auth(st.manager.accessToken))).body.data.deleted).toBe(true);
    const cap = find(await menu(), "Cappuccino"); expect((await api().delete(`/api/admin/products/${cap.id}`).set(auth(st.manager.accessToken))).body.data.disabled).toBe(true);
  });
  it("tables, QR codes, settings and wifi", async () => {
    const st = await staffTokens();
    const t = await api().post("/api/admin/tables").set(auth(st.manager.accessToken)).send({ number: 21, capacity: 2, posX: 10, posY: 10 }); expect(t.status).toBe(201);
    expect((await api().post("/api/admin/tables").set(auth(st.manager.accessToken)).send({ number: 21 })).status).toBe(409);
    const qrs = (await api().get("/api/admin/qr-codes").set(auth(st.manager.accessToken))).body.data; expect(qrs).toHaveLength(21); expect(qrs[0].png).toMatch(/^data:image\/png;base64,/); expect(qrs[0].url).toMatch(/\/table\//);
    const tok = qrs.find((q: any) => q.number === 21).url.split("/table/")[1]; expect((await api().post("/api/qr/resolve").send({ token: tok })).status).toBe(200); // generated QR resolves to the right table
    expect((await api().put("/api/admin/settings").set(auth(st.manager.accessToken)).send({ name: "x" })).status).toBe(403);
    expect((await api().put("/api/admin/settings").set(auth(st.owner.accessToken)).send({ name: "Maple & Oak", taxPercent: 12, settings: { wifi: { ssid: "MapleNet", password: "pw123456" } } })).status).toBe(200);
    const sess = await scan(21); expect((await api().get("/api/wifi").set(cs(sess.sessionToken))).body.data.ssid).toBe("MapleNet"); expect(sess.restaurant.name).toBe("Maple & Oak");
    const pr = await api().post("/api/cart/price").set(cs(sess.sessionToken)).send({ lines: [{ productId: find(await menu(), "Tiramisu").id, quantity: 1 }] }); expect(pr.body.data.tax).toBe(Math.round(26000 * 0.12)); // new tax % applies
    expect((await api().delete(`/api/admin/tables/${t.body.data.id}`).set(auth(st.manager.accessToken))).status).toBe(409); // active session
  });
  it("analytics reflect real paid orders; CSV export; payments summary; audit log", async () => {
    const st = await staffTokens(); const before = (await api().get("/api/admin/analytics/overview").set(auth(st.manager.accessToken))).body.data;
    const { sess } = await servedOrder(12, ["Tiramisu", "Tiramisu"]); await api().post("/api/billing/request").set(cs(sess.sessionToken)); const p = await pay(sess.sessionToken, { tipPercent: 5 }); await settle(sess.sessionToken, p.body.data.payment.id);
    const after = (await api().get("/api/admin/analytics/overview").set(auth(st.manager.accessToken))).body.data; expect(after.todayRevenue).toBeGreaterThan(before.todayRevenue);
    const rev = (await api().get("/api/admin/analytics/revenue?granularity=day").set(auth(st.manager.accessToken))).body.data; expect(rev.length).toBeGreaterThan(0);
    const csv = await api().get("/api/admin/analytics/products?format=csv").set(auth(st.manager.accessToken)); expect(csv.headers["content-type"]).toMatch(/csv/); expect(csv.text.split("\n")[0]).toContain("revenue");
    for (const ep of ["categories", "peak-hours", "tables", "staff", "retention", "prep-time", "coupons", "payment-methods"]) expect((await api().get(`/api/admin/analytics/${ep}`).set(auth(st.manager.accessToken))).status, ep).toBe(200);
    const pays = (await api().get("/api/admin/payments").set(auth(st.manager.accessToken))).body.data; expect(pays.payments.length).toBeGreaterThan(0); expect(pays.summary.some((x: any) => x.tips > 0)).toBe(true);
    const logs = (await api().get("/api/admin/audit-logs").set(auth(st.manager.accessToken))).body.data; expect(logs.some((l: any) => l.action === "product.create")).toBe(true);
    expect((await api().get("/api/admin/analytics/overview").set(auth(st.waiter.accessToken))).status).toBe(403);
  });
  it("floor map, overview, table assignment and layout", async () => {
    const st = await staffTokens(); const floor = (await api().get("/api/staff/floor").set(auth(st.waiter.accessToken))).body.data; expect(floor.length).toBeGreaterThanOrEqual(20);
    const ov = (await api().get("/api/staff/overview").set(auth(st.waiter.accessToken))).body.data; expect(ov.totalTables).toBe(floor.length);
    const w2 = (await api().get("/api/staff/waiters").set(auth(st.waiter.accessToken))).body.data[1];
    expect((await api().patch(`/api/staff/tables/${floor[0].id}`).set(auth(st.waiter.accessToken)).send({ assignedWaiterId: w2.id })).status).toBe(403);
    expect((await api().patch(`/api/staff/tables/${floor[0].id}`).set(auth(st.manager.accessToken)).send({ assignedWaiterId: w2.id })).status).toBe(200);
    expect((await api().put("/api/admin/tables-layout").set(auth(st.manager.accessToken)).send({ tables: [{ id: floor[0].id, posX: 500, posY: 400 }] })).status).toBe(200);
    const g = (await api().get("/api/staff/floor").set(auth(st.waiter.accessToken))).body.data.find((t: any) => t.id === floor[0].id); expect(g.posX).toBe(500); expect(g.waiter).toBe(w2.name);
  });
});
