import { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/errors";
export function errorHandler(rawErr: any, _req: Request, res: Response, _next: NextFunction) {
  const err = rawErr?.cause?.code ? rawErr.cause : rawErr; // drizzle wraps pg errors in DrizzleQueryError.cause
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ success: false, error: { code: "BAD_JSON", message: "Invalid JSON" } });
  if (err?.code === "23505") return res.status(409).json({ success: false, error: { code: "DUPLICATE", message: "Resource already exists" } });
  if (err?.code === "23503") return res.status(409).json({ success: false, error: { code: "IN_USE", message: "Resource is referenced by other records" } });
  console.error("[error]", err);
  res.status(500).json({ success: false, error: { code: "INTERNAL", message: "Internal server error" } });
}
export const notFoundHandler = (_req: Request, res: Response) => res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found" } });
