import { NextFunction, Request, Response } from "express";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db, schema as s } from "../db";
import { verifyAccess, sha256 } from "../utils/crypto";
import { forbidden, unauthorized } from "../utils/errors";

export type Staff = { id: string; role: string; rid: string; name: string };
export type CustomerCtx = { sessionId: string; tableSessionId: string; tableId: string; rid: string; customerId: string | null; displayName: string | null; closed: boolean };
declare global { namespace Express { interface Request { staff?: Staff; cust?: CustomerCtx } } }

export const ROLES = { ADMIN: ["SUPER_ADMIN", "RESTAURANT_OWNER"], MGMT: ["SUPER_ADMIN", "RESTAURANT_OWNER", "MANAGER"], FLOOR: ["SUPER_ADMIN", "RESTAURANT_OWNER", "MANAGER", "WAITER", "CASHIER"], KITCHEN: ["SUPER_ADMIN", "RESTAURANT_OWNER", "MANAGER", "KITCHEN_STAFF"], ANY_STAFF: ["SUPER_ADMIN", "RESTAURANT_OWNER", "MANAGER", "WAITER", "CASHIER", "KITCHEN_STAFF"] };

export function staffFromToken(token: string): Staff {
  try {
    const c = verifyAccess(token);
    if (!c.rid) throw new Error("no tenant");
    return { id: c.sub, role: c.role, rid: c.rid, name: c.name };
  } catch { throw unauthorized("Invalid or expired token"); }
}
export const requireStaff = (...roles: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return next(unauthorized());
  try { req.staff = staffFromToken(h.slice(7)); } catch (e) { return next(e); }
  if (roles.length && !roles.includes(req.staff.role)) return next(forbidden("Insufficient role"));
  next();
};

export async function customerFromToken(token: string): Promise<CustomerCtx> {
  const [row] = await db.select({ cs: s.customerSessions, ts: s.tableSessions }).from(s.customerSessions)
    .innerJoin(s.tableSessions, eq(s.tableSessions.id, s.customerSessions.tableSessionId))
    .where(and(eq(s.customerSessions.tokenHash, sha256(token)), or(isNull(s.tableSessions.closedAt), gt(s.tableSessions.closedAt, new Date(Date.now() - 24 * 3600_000))))).limit(1);
  if (!row) throw unauthorized("Session expired — please scan the table QR again");
  return { sessionId: row.cs.id, tableSessionId: row.ts.id, tableId: row.ts.tableId, rid: row.ts.restaurantId, customerId: row.cs.customerId, displayName: row.cs.displayName, closed: !!row.ts.closedAt };
}
export const requireCustomer = async (req: Request, _res: Response, next: NextFunction) => {
  const t = req.headers["x-session-token"];
  if (typeof t !== "string") return next(unauthorized("Missing session token"));
  try {
    req.cust = await customerFromToken(t);
    // Closed (paid) sessions stay readable for 24h (receipt, review) but cannot create anything new.
    const allowed = /^\/(reviews|favourites\/|receipts\/|payments\/[^/]+\/verify|customer\/identify|loyalty\/birthday)/;
    if (req.cust.closed && !["GET", "HEAD"].includes(req.method) && !allowed.test(req.path)) return next(forbidden("This table session is closed — scan the QR code again to order"));
    next();
  } catch (e) { next(e); }
};
/** Either staff (Bearer) or customer (x-session-token). Sets req.staff or req.cust. */
export const requireStaffOrCustomer = async (req: Request, res: Response, next: NextFunction) => {
  if (req.headers.authorization) return requireStaff()(req, res, next);
  return requireCustomer(req, res, next);
};
