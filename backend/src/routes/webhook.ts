import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, schema as s } from "../db";
import { verifyWebhook } from "../services/gateway";
import { finalize } from "../services/billing";

export const webhookRouter = Router();
/** Razorpay webhook: signature-verified; idempotent via finalize(). */
webhookRouter.post("/", async (req, res) => {
  try {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyWebhook(raw, String(req.headers["x-razorpay-signature"] || ""))) return res.status(400).json({ success: false, error: { code: "BAD_SIGNATURE", message: "Invalid signature" } });
    const evt = JSON.parse(raw.toString());
    const ent = evt?.payload?.payment?.entity;
    if (ent?.order_id) {
      const [p] = await db.select().from(s.payments).where(eq(s.payments.providerOrderId, ent.order_id));
      if (p) {
        if (evt.event === "payment.captured" && Number(ent.amount) === p.amount + p.tip) { await db.update(s.payments).set({ providerPaymentId: ent.id }).where(eq(s.payments.id, p.id)); await finalize(p.id, p.restaurantId); }
        else if (evt.event === "payment.failed" && p.status === "PENDING") await db.update(s.payments).set({ status: "FAILED" }).where(eq(s.payments.id, p.id));
      }
    }
    res.json({ received: true });
  } catch (e: any) { console.error("webhook error", e.message); res.status(200).json({ received: true, note: "processed with error" }); }
});
