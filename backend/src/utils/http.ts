import { NextFunction, Request, Response, RequestHandler } from "express";
import { ZodSchema } from "zod";
import { bad } from "./errors";
export const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler => (req, res, next) => { fn(req, res, next).catch(next); };
export const ok = (res: Response, data: unknown, status = 200, meta?: unknown) => res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw bad("Validation failed", r.error.flatten());
  return r.data;
}
export const paging = (q: any) => { const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(100, Math.max(1, Number(q.limit) || 25)); return { page, limit, offset: (page - 1) * limit }; };
