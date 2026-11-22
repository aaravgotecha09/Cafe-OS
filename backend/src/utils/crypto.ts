import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { env } from "../config/env";

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");
export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const verifyPassword = (p: string, h: string) => bcrypt.compare(p, h);

export type AccessClaims = { sub: string; role: string; rid: string | null; name: string };
export const signAccess = (c: AccessClaims) => jwt.sign(c, env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
export const verifyAccess = (t: string) => jwt.verify(t, env.JWT_ACCESS_SECRET) as AccessClaims & jwt.JwtPayload;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const hmac = (data: string) => crypto.createHmac("sha256", env.QR_SIGNING_SECRET).update(data).digest("base64url");
/** Signed QR token: base64url(payload).signature. Nonce lets admins revoke/rotate a table's QR. */
export function signQr(p: { r: string; t: string; n: string }) { const body = b64(JSON.stringify(p)); return `${body}.${hmac(body)}`; }
export function verifyQr(token: string): { r: string; t: string; n: string } | null {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const expected = hmac(body);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
}
export const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
