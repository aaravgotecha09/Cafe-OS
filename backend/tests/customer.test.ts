import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { api, auth, boot, cs, find, login, menu, qrFor, scan, shutdown } from "./helpers";
import { db, schema as s } from "../src/db";
import { signQr } from "../src/utils/crypto";

beforeAll(boot); afterAll(shutdown);
describe("QR table sessions", () => {
  it("rejects tampered / unsigned / rotated tokens", async () => {
    const { table, token } = await qrFor(5);
    expect((await api().post("/api/qr/resolve").send({ token: token.slice(0, -2) + "xx" })).status).toBe(400);
    expect((await api().post("/api/qr/resolve").send({ token: "not-a-token-at-all" })).status).toBe(400);
    const forged = Buffer.from(JSON.stringify({ r: table.restaurantId, t: table.id, n: table.qrNonce })).toString("base64url") + ".AAAA";
    expect((await api().post("/api/qr/resolve").send({ token: forged })).status).toBe(400);
    const staff = await login("owner@orangeoak.test");
    expect((await api().post(`/api/admin/tables/${table.id}/rotate-qr`).set(auth(staff.accessToken))).status).toBe(200);
    expect((await api().post("/api/qr/resolve").send({ token })).status).toBe(400); // old QR revoked
  });
  it("two diners at one table share the table session but keep separate carts/orders", async () => {
    const a = await scan(7, "Asha"); const b = await scan(7, "Bilal");
    expect(a.tableSessionId).toBe(b.tableSessionId); expect(a.sessionToken).not.toBe(b.sessionToken);
    const p = await menu(); const fries = find(p, "Peri Peri Fries");
    const o = await api().post("/api/orders").set(cs(a.sessionToken)).send({ lines: [{ productId: fries.id, quantity: 1 }] }); expect(o.status).toBe(201);
    const mine = await api().get("/api/orders").set(cs(b.sessionToken)); expect(mine.body.data).toHaveLength(0);
    expect((await api().get(`/api/orders/${o.body.data.id}`).set(cs(b.sessionToken))).status).toBe(200); // same table may view
    const other = await scan(8);
    expect((await api().get(`/api/orders/${o.body.data.id}`).set(cs(other.sessionToken))).status).toBe(404); // other table may not
  });
});
describe("menu & pricing", () => {
  it("serves 40+ products from the DB, filters work", async () => {
    const all = await menu(); expect(all.length).toBeGreaterThanOrEqual(40);
    const veg = (await api().get("/api/menu?restaurant=orange-oak&diet=veg")).body.data.products; expect(veg.every((p: any) => p.diet === "VEG")).toBe(true);
    const q = (await api().get("/api/menu?restaurant=orange-oak&q=cappu")).body.data.products; expect(q.map((p: any) => p.name)).toContain("Cappuccino");
    expect((await api().get("/api/menu?restaurant=nope")).status).toBe(404);
  });
  it("recomputes price on the server including customizations; ignores client totals", async () => {
    const t = await scan(9); const p = await menu(); const cap = find(p, "Cappuccino");
    const large = cap.variants.find((v: any) => v.name === "Large"); const milk = cap.customizationGroups.find((g: any) => g.name === "Milk"); const oat = milk.options.find((o: any) => o.name === "Oat milk");
    const extras = cap.customizationGroups.find((g: any) => g.name === "Extras"); const shot = extras.options.find((o: any) => o.name === "Extra espresso shot");
    const r = await api().post("/api/cart/price").set(cs(t.sessionToken)).send({ lines: [{ productId: cap.id, variantId: large.id, optionIds: [oat.id, shot.id], quantity: 2 }], total: 1, unitPrice: 1 });
    expect(r.status).toBe(200);
    const unit = 18000 + large.priceDelta + oat.priceDelta + shot.priceDelta; expect(r.body.data.subtotal).toBe(unit * 2); expect(r.body.data.tax).toBe(Math.round(unit * 2 * 0.05)); expect(r.body.data.total).toBe(unit * 2 + Math.round(unit * 2 * 0.05));
    // required group missing → rejected; foreign option rejected
    expect((await api().post("/api/cart/price").set(cs(t.sessionToken)).send({ lines: [{ productId: cap.id, optionIds: [], quantity: 1 }] })).status).toBe(400);
    const pizza = find(p, "Margherita Pizza"); expect((await api().post("/api/cart/price").set(cs(t.sessionToken)).send({ lines: [{ productId: pizza.id, optionIds: [oat.id], quantity: 1 }] })).status).toBe(400);
  });
  it("validates coupons (min order, first order, expiry, BOGO)", async () => {
    const t = await scan(10); const p = await menu(); const cap = find(p, "Cappuccino"); const brownie = find(p, "Chocolate Brownie with Ice Cream");
    const milk = cap.customizationGroups.find((g: any) => g.name === "Milk").options[0].id;
    const price = (lines: any, couponCode: string) => api().post("/api/cart/price").set(cs(t.sessionToken)).send({ lines, couponCode });
    expect((await price([{ productId: brownie.id, quantity: 1 }], "NOPE")).status).toBe(400);
    expect((await price([{ productId: brownie.id, quantity: 1 }], "FLAT50")).status).toBe(400); // min order not met (₹230 < ₹300)
    const flat = await price([{ productId: brownie.id, quantity: 2 }], "flat50"); expect(flat.body.data.discount).toBe(5000);
    expect((await price([{ productId: brownie.id, quantity: 1 }], "WELCOME10")).status).toBe(400); // needs identified customer
    const bogo = await price([{ productId: cap.id, optionIds: [milk], quantity: 2 }], "BOGOCOFFEE"); expect(bogo.body.data.discount).toBe(18000);
  });
  it("blocks unavailable products", async () => {
    const t = await scan(11); const owner = await login("owner@orangeoak.test"); const p = await menu(); const x = find(p, "Greek Salad");
    await api().patch(`/api/admin/products/${x.id}`).set(auth(owner.accessToken)).send({ available: false });
    const r = await api().post("/api/orders").set(cs(t.sessionToken)).send({ lines: [{ productId: x.id, quantity: 1 }] }); expect(r.status).toBe(400); expect(r.body.error.message).toMatch(/unavailable/);
    await api().patch(`/api/admin/products/${x.id}`).set(auth(owner.accessToken)).send({ available: true });
  });
});
describe("service requests", () => {
  it("creates, de-duplicates, flows through staff states, and enforces cooldown", async () => {
    const t = await scan(12); const w = await login("waiter1@orangeoak.test");
    const r = await api().post("/api/requests").set(cs(t.sessionToken)).send({ type: "WATER" }); expect(r.status).toBe(201);
    expect((await api().post("/api/requests").set(cs(t.sessionToken)).send({ type: "WATER" })).status).toBe(409);
    expect((await api().post("/api/requests").set(cs(t.sessionToken)).send({ type: "CUSTOM" })).status).toBe(400);
    const q = await api().get("/api/staff/requests").set(auth(w.accessToken)); expect(q.body.data.some((x: any) => x.id === r.body.data.id && x.tableNumber === 12)).toBe(true);
    expect((await api().post(`/api/staff/requests/${r.body.data.id}/acknowledge`).set(auth(w.accessToken))).status).toBe(200);
    expect((await api().post(`/api/staff/requests/${r.body.data.id}/acknowledge`).set(auth(w.accessToken))).status).toBe(400);
    expect((await api().post(`/api/staff/requests/${r.body.data.id}/complete`).set(auth(w.accessToken))).status).toBe(200);
    expect((await api().post("/api/requests").set(cs(t.sessionToken)).send({ type: "WATER" })).status).toBe(429);
    expect((await api().post("/api/requests").set(cs(t.sessionToken)).send({ type: "NAPKINS" })).status).toBe(201);
  });
});
describe("wifi", () => {
  it("exposes only configured Wi-Fi", async () => {
    const t = await scan(13); const r = await api().get("/api/wifi").set(cs(t.sessionToken)); expect(r.body.data.ssid).toBe("OrangeOak-Guest"); expect(r.body.data.qrPayload).toMatch(/^WIFI:T:WPA;S:OrangeOak-Guest;/);
    expect((await api().get("/api/wifi")).status).toBe(401);
  });
});
