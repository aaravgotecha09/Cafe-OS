import { db, schema as s, Executor } from "../db";
import { emitTo, rooms } from "../sockets";

/** Persist then emit: DB is source of truth, socket is a delivery hint. */
export async function notify(rid: string, p: { role?: string; title: string; body?: string; kind?: string; customerSessionId?: string }, ex: Executor = db) {
  const [n] = await ex.insert(s.notifications).values({ restaurantId: rid, role: p.role ?? null, title: p.title, body: p.body ?? null, kind: p.kind ?? "info", customerSessionId: p.customerSessionId ?? null }).returning();
  emitTo(p.role ? rooms.role(rid, p.role) : rooms.staff(rid), "notification:new", n);
  return n;
}
export async function audit(rid: string | null, userId: string | null, action: string, entity?: string, entityId?: string, meta: object = {}, ex: Executor = db) {
  await ex.insert(s.auditLogs).values({ restaurantId: rid, userId, action, entity, entityId, meta });
}
