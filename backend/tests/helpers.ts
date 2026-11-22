import http from "http";
import request from "supertest";
import { io as ioc, Socket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { initSockets } from "../src/sockets";
import { db, pool, schema as s } from "../src/db";
import { seedDemo } from "../src/db/seed";
import { signQr } from "../src/utils/crypto";

export const app = createApp();
export const api = () => request(app);
let server: http.Server; export let port = 0;
export async function boot() {
  await seedDemo({ reset: true, password: "Test@12345", withHistory: false });
  server = http.createServer(app); initSockets(server);
  await new Promise<void>((r) => server.listen(0, r)); port = (server.address() as any).port;
}
export async function shutdown() { const { closeIo } = await import("../src/sockets"); await closeIo(); await pool.end(); }
export const PASSWORD = "Test@12345";
export async function login(email: string) { const r = await api().post("/api/auth/login").send({ email, password: PASSWORD }); if (r.status !== 200) throw new Error("login failed " + JSON.stringify(r.body)); return r.body.data as { accessToken: string; refreshToken: string; user: any }; }
export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
export async function qrFor(tableNumber: number) { const [t] = await db.select().from(s.cafeTables).where(eq(s.cafeTables.number, tableNumber)); return { table: t, token: signQr({ r: t.restaurantId, t: t.id, n: t.qrNonce }) }; }
export async function scan(tableNumber: number, displayName?: string) { const { token } = await qrFor(tableNumber); const r = await api().post("/api/qr/resolve").send({ token, displayName }); if (r.status !== 200) throw new Error("scan failed " + JSON.stringify(r.body)); return r.body.data as { sessionToken: string; tableSessionId: string; table: any; restaurant: any }; }
export const cs = (t: string) => ({ "x-session-token": t });
export async function menu() { const r = await api().get("/api/menu?restaurant=orange-oak"); return r.body.data.products as any[]; }
export const find = (ps: any[], name: string) => ps.find((p) => p.name === name);
export function connect(auth: object): Promise<Socket> { return new Promise((res, rej) => { const s = ioc(`http://localhost:${port}`, { auth, transports: ["websocket"] }); s.on("connect", () => res(s)); s.on("connect_error", rej); }); }
export const waitFor = (sock: Socket, ev: string, pred: (p: any) => boolean = () => true, ms = 5000) => new Promise<any>((res, rej) => { const t = setTimeout(() => rej(new Error("timeout waiting for " + ev)), ms); sock.on(ev, (p) => { if (pred(p)) { clearTimeout(t); res(p); } }); });
export async function staffTokens() { const [waiter, kitchen, barista, cashier, owner, manager] = await Promise.all(["waiter1", "kitchen", "barista", "cashier", "owner", "manager"].map((n) => login(`${n}@orangeoak.test`))); return { waiter, kitchen, barista, cashier, owner, manager }; }
/** Place an order for a table and drive it to SERVED through the real staff/kitchen APIs. */
export async function servedOrder(tableNo: number, names: string[], opts: { identify?: boolean; sessionToken?: string; tableSessionId?: string } = {}) {
  const st = await staffTokens(); const p = await menu();
  const sess = opts.sessionToken ? { sessionToken: opts.sessionToken, tableSessionId: opts.tableSessionId! } : await scan(tableNo, "Tester");
  if (opts.identify) await api().post("/api/customer/identify").set(cs(sess.sessionToken)).send({ name: "Tester", phone: "+9199" + String(Math.floor(10000000 + Math.random() * 89999999)), consent: true });
  const lines = names.map((n) => { const prod = find(p, n); const req = prod.customizationGroups.filter((g: any) => g.required).map((g: any) => g.options[0].id); return { productId: prod.id, optionIds: req, quantity: 1 }; });
  const o = await api().post("/api/orders").set(cs(sess.sessionToken)).send({ lines }); if (o.status !== 201) throw new Error(JSON.stringify(o.body));
  const id = o.body.data.id;
  await api().post(`/api/staff/orders/${id}/status`).set(auth(st.waiter.accessToken)).send({ status: "SENT_TO_KITCHEN" });
  const full = (await api().get(`/api/staff/orders/${id}`).set(auth(st.waiter.accessToken))).body.data;
  for (const t of full.tickets) { await api().post(`/api/kitchen/tickets/${t.id}/start`).set(auth(st.kitchen.accessToken)); await api().post(`/api/kitchen/tickets/${t.id}/ready`).set(auth(st.kitchen.accessToken)); }
  await api().post(`/api/staff/orders/${id}/status`).set(auth(st.waiter.accessToken)).send({ status: "SERVED" });
  return { id, sess, st, order: o.body.data };
}
