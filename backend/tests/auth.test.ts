import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { api, auth, boot, login, shutdown } from "./helpers";

beforeAll(boot); afterAll(shutdown);
describe("authentication & authorization", () => {
  it("logs in with valid credentials and rejects invalid ones", async () => {
    const ok = await api().post("/api/auth/login").send({ email: "waiter1@orangeoak.test", password: "Test@12345" });
    expect(ok.status).toBe(200); expect(ok.body.data.accessToken).toBeTruthy();
    expect((await api().post("/api/auth/login").send({ email: "waiter1@orangeoak.test", password: "nope" })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: "ghost@x.test", password: "nope" })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: "bad", password: "" })).status).toBe(400);
  });
  it("rotates refresh tokens and detects reuse", async () => {
    const a = await login("manager@orangeoak.test");
    const r1 = await api().post("/api/auth/refresh").send({ refreshToken: a.refreshToken }); expect(r1.status).toBe(200);
    const reuse = await api().post("/api/auth/refresh").send({ refreshToken: a.refreshToken }); expect(reuse.status).toBe(401);
    const afterTheft = await api().post("/api/auth/refresh").send({ refreshToken: r1.body.data.refreshToken }); expect(afterTheft.status).toBe(401); // whole family revoked
  });
  it("enforces role permissions", async () => {
    const waiter = await login("waiter1@orangeoak.test"); const kitchen = await login("kitchen@orangeoak.test"); const owner = await login("owner@orangeoak.test");
    expect((await api().get("/api/admin/staff").set(auth(waiter.accessToken))).status).toBe(403);
    expect((await api().get("/api/admin/menu")).status).toBe(401);
    expect((await api().get("/api/staff/orders").set(auth(kitchen.accessToken))).status).toBe(200);
    expect((await api().post("/api/staff/orders/00000000-0000-0000-0000-000000000000/status").set(auth(kitchen.accessToken)).send({ status: "CONFIRMED" })).status).toBe(403);
    expect((await api().get("/api/admin/staff").set(auth(owner.accessToken))).status).toBe(200);
    expect((await api().get("/api/admin/staff").set({ Authorization: "Bearer garbage" })).status).toBe(401);
  });
  it("manager cannot mint owners; owner can create staff", async () => {
    const mgr = await login("manager@orangeoak.test"); const owner = await login("owner@orangeoak.test");
    expect((await api().post("/api/admin/staff").set(auth(mgr.accessToken)).send({ name: "X", email: "x1@t.test", password: "Password1", role: "RESTAURANT_OWNER" })).status).toBe(403);
    const r = await api().post("/api/admin/staff").set(auth(owner.accessToken)).send({ name: "New Waiter", email: "nw@t.test", password: "Password1", role: "WAITER" }); expect(r.status).toBe(201);
    expect((await api().post("/api/auth/login").send({ email: "nw@t.test", password: "Password1" })).status).toBe(200);
  });
  it("registers a new restaurant (multi-tenant) with isolated data", async () => {
    const r = await api().post("/api/auth/register-restaurant").send({ restaurantName: "Second Cafe", name: "Owner Two", email: "two@t.test", password: "Password1" }); expect(r.status).toBe(201);
    const tok = r.body.data.accessToken; const staff = await api().get("/api/admin/staff").set(auth(tok)); expect(staff.body.data).toHaveLength(1);
    const tables = await api().get("/api/admin/tables").set(auth(tok)); expect(tables.body.data).toHaveLength(0);
  });
  it("password reset flow", async () => {
    const f = await api().post("/api/auth/forgot-password").send({ email: "cashier@orangeoak.test" }); expect(f.body.data.devToken).toBeTruthy();
    expect((await api().post("/api/auth/reset-password").send({ token: f.body.data.devToken, password: "NewPassw0rd" })).status).toBe(200);
    expect((await api().post("/api/auth/reset-password").send({ token: f.body.data.devToken, password: "Another1234" })).status).toBe(400);
    expect((await api().post("/api/auth/login").send({ email: "cashier@orangeoak.test", password: "NewPassw0rd" })).status).toBe(200);
  });
});
