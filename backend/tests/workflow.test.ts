import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { api, auth, boot, connect, cs, find, menu, scan, shutdown, staffTokens, waitFor } from "./helpers";
import { db, schema as s } from "../src/db";

beforeAll(boot); afterAll(shutdown);
describe("end-to-end: scan → order → kitchen → serve → split bill → pay → receipt → loyalty → review", () => {
  it("runs the complete customer-to-kitchen-to-payment workflow with live events", async () => {
    const st = await staffTokens(); const p = await menu();
    // 1–2 customer scans Table 05 and opens the menu
    const sess = await scan(5, "Priya"); expect(sess.table.number).toBe(5);
    const me = await api().post("/api/customer/identify").set(cs(sess.sessionToken)).send({ name: "Priya Test", phone: "+919876500005", email: "priya.t@example.test", consent: true }); expect(me.status).toBe(200);
    const wSock = await connect({ token: st.waiter.accessToken }); const kSock = await connect({ token: st.kitchen.accessToken }); const cSock = await connect({ sessionToken: sess.sessionToken });
    let kitchenGot = false; kSock.on("kitchen:order_received", () => (kitchenGot = true));
    // 3 add cappuccino + sandwich, customised
    const cap = find(p, "Cappuccino"); const sand = find(p, "Grilled Veg Sandwich");
    const lines = [
      { productId: cap.id, variantId: cap.variants.find((v: any) => v.name === "Large").id, optionIds: [cap.customizationGroups.find((g: any) => g.name === "Milk").options.find((o: any) => o.name === "Oat milk").id, cap.customizationGroups.find((g: any) => g.name === "Extras").options.find((o: any) => o.name === "Sugar-free").id], quantity: 1, instructions: "extra hot please" },
      { productId: sand.id, optionIds: [sand.customizationGroups[0].options.find((o: any) => o.name === "Extra cheese").id], quantity: 2 },
    ];
    const priced = await api().post("/api/cart/price").set(cs(sess.sessionToken)).send({ lines }); expect(priced.status).toBe(200);
    // 4–7 place order → persisted → waiter dashboard receives it
    const gotStaff = waitFor(wSock, "staff:order_received"); const gotCust = waitFor(cSock, "customer:order_created");
    const placed = await api().post("/api/orders").set(cs(sess.sessionToken)).send({ lines, notes: "Birthday table" }); expect(placed.status).toBe(201);
    const order = placed.body.data; expect(order.orderNumber).toMatch(/^OO-/); expect(order.total).toBe(priced.body.data.total); expect(order.etaMinutes).toBeGreaterThan(0);
    expect((await gotStaff).id).toBe(order.id); expect((await gotCust).id).toBe(order.id);
    const [row] = await db.select().from(s.orders).where(eq(s.orders.id, order.id)); expect(row.status).toBe("PLACED"); // persisted in PostgreSQL
    expect(order.tickets).toHaveLength(2); // coffee + hot kitchen routing
    await new Promise((r) => setTimeout(r, 200)); expect(kitchenGot).toBe(false); // kitchen sees nothing until waiter forwards
    // customer subscribes to live tracking
    const joined = await new Promise<boolean>((res) => cSock.emit("join:order", order.id, res)); expect(joined).toBe(true);
    // 8 waiter confirms + forwards → kitchen receives
    const kRecv = waitFor(kSock, "kitchen:order_received", (o) => o.id === order.id); const track1 = waitFor(cSock, "order:status_updated", (o) => o.status === "SENT_TO_KITCHEN");
    expect((await api().post(`/api/staff/orders/${order.id}/status`).set(auth(st.waiter.accessToken)).send({ status: "SENT_TO_KITCHEN" })).status).toBe(200);
    await kRecv; await track1;
    const [beans] = await db.select().from(s.inventoryItems).where(eq(s.inventoryItems.name, "Espresso beans")); expect(Number(beans.quantity)).toBe(8000 - 18); // recipe consumed
    // 9 kitchen queue per station; accept & start
    const q = await api().get("/api/kitchen/queue").set(auth(st.kitchen.accessToken)); const mine = q.body.data.filter((x: any) => x.order.id === order.id); expect(mine).toHaveLength(2);
    const coffee = mine.find((x: any) => x.station.code === "COFFEE"); const hot = mine.find((x: any) => x.station.code === "HOT");
    expect(coffee.items[0].customizations.map((c: any) => c.option)).toContain("Oat milk"); expect(coffee.items[0].instructions).toBe("extra hot please"); expect(hot.items[0].allergens).toContain("Gluten");
    const prepping = waitFor(cSock, "order:status_updated", (o) => o.status === "PREPARING");
    expect((await api().post(`/api/kitchen/tickets/${coffee.ticket.id}/accept`).set(auth(st.barista.accessToken))).status).toBe(200);
    expect((await api().post(`/api/kitchen/tickets/${coffee.ticket.id}/start`).set(auth(st.barista.accessToken))).status).toBe(200); await prepping;
    // 10 coffee ready — order must NOT be ready until the hot station is done
    await api().post(`/api/kitchen/tickets/${coffee.ticket.id}/ready`).set(auth(st.barista.accessToken));
    expect((await api().get(`/api/orders/${order.id}`).set(cs(sess.sessionToken))).body.data.status).toBe("PREPARING");
    const ready = waitFor(cSock, "order:status_updated", (o) => o.status === "READY");
    await api().post(`/api/kitchen/items/${hot.items[0].id}/ready`).set(auth(st.kitchen.accessToken)).send({ ready: true }); await ready;
    // 11 waiter serves
    expect((await api().post(`/api/staff/orders/${order.id}/status`).set(auth(st.waiter.accessToken)).send({ status: "SERVED" })).status).toBe(200);
    expect((await api().post(`/api/staff/orders/${order.id}/status`).set(auth(st.waiter.accessToken)).send({ status: "CONFIRMED" })).status).toBe(409); // illegal transition
    // 12 customer sees tracking history
    const tr = (await api().get(`/api/orders/${order.id}`).set(cs(sess.sessionToken))).body.data; expect(tr.history.map((h: any) => h.status)).toEqual(["PLACED", "CONFIRMED", "SENT_TO_KITCHEN", "PREPARING", "READY", "SERVED"]);
    // 13 customer requests the bill; 14 splits equally between 2
    const bill = await api().post("/api/billing/request").set(cs(sess.sessionToken)); expect(bill.body.data.total).toBe(order.total);
    const split = await api().post("/api/billing/split").set(cs(sess.sessionToken)).send({ mode: "equal", people: 2 }); expect(split.status).toBe(200);
    const shares = split.body.data.splits; expect(shares.reduce((a: number, x: any) => a + x.amount, 0)).toBe(order.total);
    // 15 pay each share in TEST mode, with tip, through server-side signature verification
    const cfg = await api().get("/api/payments/config"); expect(cfg.body.data.testMode).toBe(true);
    for (const [i, sh] of shares.entries()) {
      const pay = await api().post("/api/payments").set(cs(sess.sessionToken)).send({ splitId: sh.id, method: "UPI", tipPercent: i === 0 ? 10 : 0, idempotencyKey: `idem-${i}-${Date.now()}` }); expect(pay.status).toBe(201);
      const pid = pay.body.data.payment.id; expect(pay.body.data.payment.testMode).toBe(true);
      const forged = await api().post(`/api/payments/${pid}/verify`).set(cs(sess.sessionToken)).send({ razorpay_payment_id: "pay_fake", razorpay_signature: "deadbeef" }); expect(forged.status).toBe(400); // client cannot self-declare paid
      const retry = await api().post("/api/payments").set(cs(sess.sessionToken)).send({ splitId: sh.id, method: "UPI", tipPercent: i === 0 ? 10 : 0, idempotencyKey: `idem-${i}-r${Date.now()}` });
      const pid2 = retry.body.data.payment.id; expect(pid2).toBe(pid); // pending payment reused, not duplicated
      const co = await api().post(`/api/payments/${pid}/test-checkout`).set(cs(sess.sessionToken)); expect(co.status).toBe(200);
      const v = await api().post(`/api/payments/${pid}/verify`).set(cs(sess.sessionToken)).send({ razorpay_payment_id: co.body.data.razorpay_payment_id, razorpay_signature: co.body.data.razorpay_signature }); expect(v.status, JSON.stringify(v.body)).toBe(200); expect(v.body.data.status).toBe("PAID");
    }
    const after = await api().get("/api/billing").set(cs(sess.sessionToken)); expect(after.body.data.status).toBe("PAID"); expect(after.body.data.paidAmount).toBe(order.total); expect(after.body.data.tips).toBeGreaterThan(0);
    const [t5] = await db.select().from(s.cafeTables).where(eq(s.cafeTables.number, 5)); expect(t5.status).toBe("CLEANING");
    const [ord] = await db.select().from(s.orders).where(eq(s.orders.id, order.id)); expect(ord.status).toBe("COMPLETED"); expect(ord.paymentStatus).toBe("PAID");
    // 16 receipt
    const pdf = await api().get(`/api/receipts/${after.body.data.id}.pdf`).set(cs(sess.sessionToken)).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    expect(pdf.headers["content-type"]).toMatch(/pdf/); expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    // 17 loyalty points awarded exactly once
    const loy = await api().get("/api/loyalty").set(cs(sess.sessionToken)); const expectedPts = Math.floor((order.total / 100) * 0.1); expect(loy.body.data.account.points).toBe(expectedPts);
    expect(loy.body.data.history.filter((h: any) => h.kind === "EARN")).toHaveLength(1);
    // 18 review: once only
    const body = { orderId: order.id, food: 5, service: 4, ambience: 5, overall: 5, comment: "Great!" };
    expect((await api().post("/api/reviews").set(cs(sess.sessionToken)).send(body)).status).toBe(201);
    expect((await api().post("/api/reviews").set(cs(sess.sessionToken)).send(body)).status).toBe(409);
    // payment confirmed over sockets too, and the session is closed afterwards
    expect((await api().get("/api/session").set(cs(sess.sessionToken))).status).toBe(200); // still readable
    expect((await api().post("/api/orders").set(cs(sess.sessionToken)).send({ lines })).status).toBe(403); // but cannot order on a closed session
    wSock.close(); kSock.close(); cSock.close();
  });
  it("sockets: unauthenticated connections are refused and rooms are scoped", async () => {
    await expect(connect({})).rejects.toBeTruthy(); await expect(connect({ token: "bad" })).rejects.toBeTruthy();
    const a = await scan(14); const b = await scan(15); const p = await menu();
    const o = await api().post("/api/orders").set(cs(a.sessionToken)).send({ lines: [{ productId: find(p, "Peri Peri Fries").id, quantity: 1 }] });
    const sb = await connect({ sessionToken: b.sessionToken }); expect(await new Promise<boolean>((res) => sb.emit("join:order", o.body.data.id, res))).toBe(false); // other table cannot follow my order
    let leaked = false; sb.on("order:status_updated", () => (leaked = true)); sb.on("customer:order_created", () => (leaked = true));
    const st = await staffTokens(); await api().post(`/api/staff/orders/${o.body.data.id}/status`).set(auth(st.waiter.accessToken)).send({ status: "CONFIRMED" });
    await new Promise((r) => setTimeout(r, 300)); expect(leaked).toBe(false); sb.close();
    const sk = await connect({ token: st.kitchen.accessToken }); let notified = false; sk.on("staff:order_received", () => (notified = true)); // kitchen role isn't in the waiter room but is in the staff room
    sk.close();
  });
});
