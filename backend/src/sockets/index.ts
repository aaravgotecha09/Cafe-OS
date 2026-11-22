import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { and, eq } from "drizzle-orm";
import { env } from "../config/env";
import { db, schema as s } from "../db";
import { customerFromToken, staffFromToken } from "../middleware/auth";

let io: Server | null = null;
export const rooms = {
  role: (rid: string, role: string) => `r:${rid}:role:${role}`,
  staff: (rid: string) => `r:${rid}:staff`,
  table: (rid: string, tableId: string) => `r:${rid}:table:${tableId}`,
  order: (orderId: string) => `order:${orderId}`,
  game: (id: string) => `game:${id}`,
};
export function emitTo(room: string | string[], event: string, payload: unknown) { if (io) io.to(room as any).emit(event, payload); }
export const getIo = () => io;
export function closeIo() { return new Promise<void>((r) => (io ? io.close(() => r()) : r())); }

export function initSockets(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.FRONTEND_URL.split(","), credentials: true } });
  io.use(async (socket, next) => {
    try {
      const { token, sessionToken } = socket.handshake.auth || {};
      if (token) { const st = staffFromToken(token); socket.data = { kind: "staff", ...st }; }
      else if (sessionToken) { const c = await customerFromToken(sessionToken); socket.data = { kind: "customer", ...c }; }
      else throw new Error("auth required");
      next();
    } catch { next(new Error("unauthorized")); }
  });
  io.on("connection", (socket: Socket) => {
    const d = socket.data;
    if (d.kind === "staff") {
      socket.join(rooms.staff(d.rid)); socket.join(rooms.role(d.rid, d.role));
      if (["SUPER_ADMIN", "RESTAURANT_OWNER", "MANAGER"].includes(d.role)) for (const r of ["WAITER", "KITCHEN_STAFF", "CASHIER"]) socket.join(rooms.role(d.rid, r));
    } else {
      if (!d.closed) socket.join(rooms.table(d.rid, d.tableId)); // closed sessions must not receive the next party's events
    }
    // Customers may only follow orders that belong to their own table session.
    socket.on("join:order", async (orderId: string, ack?: (ok: boolean) => void) => {
      try {
        const [o] = await db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.id, orderId), eq(s.orders.restaurantId, d.rid), ...(d.kind === "customer" ? [eq(s.orders.tableSessionId, d.tableSessionId)] : []))).limit(1);
        if (o) socket.join(rooms.order(orderId));
        ack?.(!!o);
      } catch { ack?.(false); }
    });
    socket.on("join:game", (gameId: string, ack?: (ok: boolean) => void) => { socket.join(rooms.game(gameId)); ack?.(true); });
    socket.emit("connected", { kind: d.kind });
  });
  return io;
}
