// Live smoke test against a RUNNING stack: node scripts/smoke.mjs [API_URL] [FRONTEND_URL]
import { io } from "socket.io-client";
const API = process.argv[2] || "http://localhost:4000", WEB = process.argv[3] || "http://localhost:3000";
let fails = 0; const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };
const j = async (p, o = {}) => { const r = await fetch(API + p, { ...o, headers: { "Content-Type": "application/json", Origin: WEB, ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) }); return { status: r.status, h: r.headers, ...(await r.json().catch(() => ({}))) }; };
const h = await j("/health"); ok(h.status === "ok" && h.db === "up", "backend health + DB up");
const cors = await fetch(API + "/api/menu?restaurant=orange-oak", { headers: { Origin: WEB } }); ok(cors.headers.get("access-control-allow-origin") === WEB, "CORS allows the frontend origin");
const bad = await fetch(API + "/api/menu?restaurant=orange-oak", { headers: { Origin: "https://evil.example" } }); ok(!bad.headers.get("access-control-allow-origin"), "CORS rejects unknown origin");
const links = (await j("/api/dev/table-links")).data; ok(links.length === 20, "20 table QR links");
for (const path of ["/", "/menu", "/cart", "/checkout", "/pay", "/rewards", "/games", "/games/tic-tac-toe", "/leaderboard", "/reservations", "/assistance", "/wifi", "/profile", "/reviews", "/staff/login", "/kitchen/login", "/admin/login", "/staff/dashboard", "/admin/menu", "/kitchen/dashboard"]) { const r = await fetch(WEB + path); ok(r.status === 200, `frontend ${path} → ${r.status}`); }
const tok = links[4].url.split("/table/")[1]; const page = await fetch(links[4].url); ok(page.status === 200, "frontend /table/[qrToken] renders");
const s = await j("/api/qr/resolve", { method: "POST", body: { token: tok, displayName: "Smoke" } }); ok(s.data?.table.number === 5, "QR → Table 05 session");
const menu = (await j("/api/menu?restaurant=orange-oak")).data.products; const fries = menu.find((p) => p.name === "Peri Peri Fries"); ok(!!fries && menu.length >= 40, `menu from DB (${menu.length} dishes)`);
const waiter = (await j("/api/auth/login", { method: "POST", body: { email: "waiter1@orangeoak.test", password: process.env.DEMO_PASSWORD || "Demo@12345" } })).data; ok(!!waiter?.accessToken, "waiter login");
const ws = io(API, { auth: { token: waiter.accessToken }, transports: ["websocket"] }); await new Promise((r) => ws.on("connect", r));
const got = new Promise((r) => ws.on("staff:order_received", r)); const t0 = Date.now();
const order = await j("/api/orders", { method: "POST", headers: { "x-session-token": s.data.sessionToken }, body: { lines: [{ productId: fries.id, quantity: 1 }] } }); ok(order.status === 201, "order placed");
const ev = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 3000))]); ok(ev?.id === order.data.id, `waiter received order over Socket.IO (${Date.now() - t0} ms)`);
const fwd = await j(`/api/staff/orders/${order.data.id}/status`, { method: "POST", headers: { Authorization: `Bearer ${waiter.accessToken}` }, body: { status: "SENT_TO_KITCHEN" } }); ok(fwd.status === 200, "waiter forwards to kitchen");
const k = (await j("/api/auth/login", { method: "POST", body: { email: "kitchen@orangeoak.test", password: process.env.DEMO_PASSWORD || "Demo@12345" } })).data;
const q = await j("/api/kitchen/queue", { headers: { Authorization: `Bearer ${k.accessToken}` } }); ok(q.data.some((t) => t.order.id === order.data.id), "kitchen queue contains the order");
for (const t of q.data.filter((t) => t.order.id === order.data.id)) { await j(`/api/kitchen/tickets/${t.ticket.id}/ready`, { method: "POST", headers: { Authorization: `Bearer ${k.accessToken}` } }); }
await j(`/api/staff/orders/${order.data.id}/status`, { method: "POST", headers: { Authorization: `Bearer ${waiter.accessToken}` }, body: { status: "SERVED" } });
const pay = await j("/api/payments", { method: "POST", headers: { "x-session-token": s.data.sessionToken }, body: { method: "UPI", idempotencyKey: "smoke-" + Date.now(), tipPercent: 10 } }); ok(pay.status === 201 && pay.data.payment.testMode === true, "payment initiated in labelled TEST mode");
const forged = await j(`/api/payments/${pay.data.payment.id}/verify`, { method: "POST", headers: { "x-session-token": s.data.sessionToken }, body: { razorpay_payment_id: "x", razorpay_signature: "y" } }); ok(forged.status === 400, "forged payment verification rejected");
const co = (await j(`/api/payments/${pay.data.payment.id}/test-checkout`, { method: "POST", headers: { "x-session-token": s.data.sessionToken }, body: {} })).data;
const v = await j(`/api/payments/${pay.data.payment.id}/verify`, { method: "POST", headers: { "x-session-token": s.data.sessionToken }, body: co }); ok(v.status === 200 && v.data.status === "PAID", "server-verified payment → PAID");
ws.close(); console.log(fails ? `\n${fails} FAILED` : "\nAll smoke checks passed"); process.exit(fails ? 1 : 0);
