import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env";
import { pool } from "./db";
import { authRouter } from "./routes/auth";
import { staffRouter, kitchenRouter } from "./routes/staff";
import { adminRouter } from "./routes/admin";
import { customerRouter } from "./routes/customer";
import { webhookRouter } from "./routes/webhook";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { openapi } from "./openapi";
import { devRouter } from "./routes/dev";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  const origins = env.FRONTEND_URL.split(",").map((s) => s.trim());
  app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)), credentials: true, allowedHeaders: ["Content-Type", "Authorization", "x-session-token"] }));
  app.use("/api/payments/webhook", express.raw({ type: "application/json", limit: "1mb" }), webhookRouter); // raw body for signature check
  app.use(express.json({ limit: "8mb" }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: process.env.NODE_ENV === "test" ? 100000 : 600, standardHeaders: true, legacyHeaders: false, message: { success: false, error: { code: "RATE_LIMIT", message: "Too many requests" } } }));
  app.get("/health", async (_req, res) => { try { await pool.query("select 1"); res.json({ status: "ok", db: "up", time: new Date().toISOString() }); } catch { res.status(503).json({ status: "degraded", db: "down" }); } });
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapi));
  app.get("/api/openapi.json", (_req, res) => res.json(openapi));
  if (env.NODE_ENV !== "production") app.use("/api/dev", devRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/staff", staffRouter);
  app.use("/api/kitchen", kitchenRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api", customerRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
