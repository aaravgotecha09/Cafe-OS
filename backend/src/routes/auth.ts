import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Resend } from "resend";
import { db, schema as s } from "../db";
import { ah, ok, parse } from "../utils/http";
import { bad, forbidden, unauthorized } from "../utils/errors";
import { hashPassword, randomToken, sha256, signAccess, verifyPassword } from "../utils/crypto";
import { requireStaff } from "../middleware/auth";
import { audit } from "../services/notify";
import { env } from "../config/env";

export const authRouter = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: process.env.NODE_ENV === "test" ? 1000 : 30, standardHeaders: true, legacyHeaders: false, message: { success: false, error: { code: "RATE_LIMIT", message: "Too many attempts, try again later" } } });
const REFRESH_DAYS = 14;

async function issue(user: typeof s.users.$inferSelect) {
  const refresh = randomToken(40);
  await db.insert(s.refreshTokens).values({ userId: user.id, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400000) });
  return { accessToken: signAccess({ sub: user.id, role: user.role, rid: user.restaurantId, name: user.name }), refreshToken: refresh, user: pub(user) };
}
const pub = (u: typeof s.users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email, role: u.role, station: u.station, section: u.section, restaurantId: u.restaurantId });
const pwd = z.string().min(8).max(100);

authRouter.post("/login", limiter, ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const [u] = await db.select().from(s.users).where(eq(s.users.email, b.email.toLowerCase()));
  // constant-ish work to avoid user enumeration
  const good = u ? await verifyPassword(b.password, u.passwordHash) : (await verifyPassword(b.password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali"), false);
  if (!u || !good || !u.active) throw unauthorized("Invalid email or password");
  await audit(u.restaurantId, u.id, "auth.login");
  ok(res, await issue(u));
}));
authRouter.post("/register-restaurant", limiter, ah(async (req, res) => {
  if (process.env.ALLOW_RESTAURANT_SIGNUP !== "true" && env.NODE_ENV === "production") throw forbidden("Self-service signup is disabled");
  const b = parse(z.object({ restaurantName: z.string().min(2).max(80), name: z.string().min(1).max(60), email: z.string().email(), password: pwd }), req.body);
  const slug = b.restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + randomToken(2);
  const user = await db.transaction(async (tx) => {
    const [r] = await tx.insert(s.restaurants).values({ name: b.restaurantName, slug }).returning();
    await tx.insert(s.branches).values({ restaurantId: r.id, name: "Main branch" });
    await tx.insert(s.kitchenStations).values([{ restaurantId: r.id, name: "Hot Kitchen", code: "HOT" }, { restaurantId: r.id, name: "Coffee & Beverages", code: "COFFEE" }]);
    const [u] = await tx.insert(s.users).values({ restaurantId: r.id, email: b.email.toLowerCase(), passwordHash: await hashPassword(b.password), name: b.name, role: "RESTAURANT_OWNER" }).returning();
    return u;
  });
  ok(res, await issue(user), 201);
}));
authRouter.post("/refresh", limiter, ah(async (req, res) => {
  const b = parse(z.object({ refreshToken: z.string() }), req.body);
  const h = sha256(b.refreshToken);
  const [t] = await db.select().from(s.refreshTokens).where(eq(s.refreshTokens.tokenHash, h));
  if (!t) throw unauthorized("Invalid refresh token");
  if (t.revokedAt) { await db.update(s.refreshTokens).set({ revokedAt: new Date() }).where(and(eq(s.refreshTokens.userId, t.userId), isNull(s.refreshTokens.revokedAt))); throw unauthorized("Refresh token reuse detected — please sign in again"); }
  if (t.expiresAt < new Date()) throw unauthorized("Session expired");
  const [u] = await db.select().from(s.users).where(eq(s.users.id, t.userId));
  if (!u?.active) throw unauthorized("Account disabled");
  await db.update(s.refreshTokens).set({ revokedAt: new Date() }).where(eq(s.refreshTokens.id, t.id)); // rotation
  ok(res, await issue(u));
}));
authRouter.post("/logout", ah(async (req, res) => {
  const b = parse(z.object({ refreshToken: z.string() }), req.body);
  await db.update(s.refreshTokens).set({ revokedAt: new Date() }).where(and(eq(s.refreshTokens.tokenHash, sha256(b.refreshToken)), isNull(s.refreshTokens.revokedAt)));
  ok(res, { loggedOut: true });
}));
authRouter.get("/me", requireStaff(), ah(async (req, res) => {
  const [u] = await db.select().from(s.users).where(eq(s.users.id, req.staff!.id));
  if (!u) throw unauthorized(); ok(res, pub(u));
}));
authRouter.post("/forgot-password", limiter, ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().email() }), req.body);
  const [u] = await db.select().from(s.users).where(eq(s.users.email, b.email.toLowerCase()));
  let devToken: string | undefined;
  if (u?.active) {
    const token = randomToken(32);
    await db.insert(s.passwordResets).values({ userId: u.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) });
    const link = `${env.FRONTEND_URL}/staff/reset-password?token=${token}`;
    if (env.RESEND_API_KEY) await new Resend(env.RESEND_API_KEY).emails.send({ from: env.EMAIL_FROM, to: u.email, subject: "Reset your password", html: `<p>Reset your password: <a href="${link}">${link}</a> (valid 1 hour)</p>` }).catch((e) => console.error("reset email failed", e.message));
    else if (env.NODE_ENV !== "production") devToken = token; // dev convenience only
  }
  ok(res, { message: "If the account exists, a reset link has been sent", ...(devToken ? { devToken } : {}) });
}));
authRouter.post("/reset-password", limiter, ah(async (req, res) => {
  const b = parse(z.object({ token: z.string(), password: pwd }), req.body);
  const [t] = await db.select().from(s.passwordResets).where(and(eq(s.passwordResets.tokenHash, sha256(b.token)), isNull(s.passwordResets.usedAt), gt(s.passwordResets.expiresAt, new Date())));
  if (!t) throw bad("Invalid or expired token");
  await db.transaction(async (tx) => {
    await tx.update(s.passwordResets).set({ usedAt: new Date() }).where(eq(s.passwordResets.id, t.id));
    await tx.update(s.users).set({ passwordHash: await hashPassword(b.password) }).where(eq(s.users.id, t.userId));
    await tx.update(s.refreshTokens).set({ revokedAt: new Date() }).where(and(eq(s.refreshTokens.userId, t.userId), isNull(s.refreshTokens.revokedAt)));
  });
  ok(res, { reset: true });
}));
