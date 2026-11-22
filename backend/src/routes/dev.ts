import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { db, schema as s } from "../db";
import { ah, ok } from "../utils/http";
import { signQr } from "../utils/crypto";
import { env } from "../config/env";
import { notFound } from "../utils/errors";

/** Development-only convenience: lists signed QR links so demos don't need a printer. Never mounted in production. */
export const devRouter = Router();
devRouter.get("/table-links", ah(async (req, res) => {
  const [r] = await db.select().from(s.restaurants).where(eq(s.restaurants.slug, String(req.query.restaurant || "orange-oak")));
  if (!r) throw notFound("Restaurant not found");
  const tables = await db.select().from(s.cafeTables).where(eq(s.cafeTables.restaurantId, r.id)).orderBy(asc(s.cafeTables.number));
  ok(res, tables.map((t) => ({ number: t.number, url: `${env.FRONTEND_URL.split(",")[0]}/table/${signQr({ r: r.id, t: t.id, n: t.qrNonce })}` })));
}));
