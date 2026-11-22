import crypto from "crypto";
import Razorpay from "razorpay";
import { env } from "../config/env";
import { bad } from "../utils/errors";
import { safeEqualHex } from "../utils/crypto";

/** Real Razorpay is used only when keys are configured AND test mode is off.
 *  TEST gateway: server-issued order/payment ids signed with a server secret; the verify path is identical
 *  (HMAC over order_id|payment_id), so unverified client claims can never mark a bill paid. It never talks to a bank. */
export const liveEnabled = () => !env.PAYMENT_TEST_MODE && !!env.RAZORPAY_KEY_ID && !!env.RAZORPAY_KEY_SECRET;
const rzp = () => new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
const testSecret = () => `${env.JWT_ACCESS_SECRET}:test-gateway`;
const sign = (secret: string, orderId: string, paymentId: string) => crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

export function gatewayInfo() { return { mode: liveEnabled() ? "live" : "test", keyId: liveEnabled() ? env.RAZORPAY_KEY_ID : null, testMode: !liveEnabled(), label: liveEnabled() ? "Razorpay" : "TEST MODE — no real money moves" }; }

export async function createProviderOrder(amountPaise: number, receipt: string, currency = "INR") {
  if (liveEnabled()) { const o = await rzp().orders.create({ amount: amountPaise, currency, receipt: receipt.slice(0, 40) }); return { provider: "razorpay", providerOrderId: o.id as string, testMode: false }; }
  if (!env.PAYMENT_TEST_MODE) throw bad("Online payments are not configured");
  return { provider: "test", providerOrderId: `test_order_${crypto.randomBytes(8).toString("hex")}`, testMode: true };
}
/** TEST-mode only: issues a payment id + signature, as the Razorpay checkout would hand back after a real payment. */
export function testGatewayPay(providerOrderId: string) {
  if (liveEnabled() || !providerOrderId.startsWith("test_order_")) throw bad("Test gateway unavailable");
  const paymentId = `test_pay_${crypto.randomBytes(8).toString("hex")}`;
  return { razorpay_order_id: providerOrderId, razorpay_payment_id: paymentId, razorpay_signature: sign(testSecret(), providerOrderId, paymentId) };
}
export async function verifyProviderPayment(p: { providerOrderId: string; testMode: boolean; amountPaise: number }, paymentId: string, signature: string) {
  if (p.testMode) {
    if (liveEnabled()) throw bad("Test payment cannot be verified in live mode");
    if (!safeEqualHex(sign(testSecret(), p.providerOrderId, paymentId), signature)) throw bad("Invalid payment signature");
    return true;
  }
  if (!safeEqualHex(sign(env.RAZORPAY_KEY_SECRET, p.providerOrderId, paymentId), signature)) throw bad("Invalid payment signature");
  const remote: any = await rzp().payments.fetch(paymentId); // server-side confirmation with the provider
  if (remote.order_id !== p.providerOrderId || Number(remote.amount) !== p.amountPaise || !["captured", "authorized"].includes(remote.status)) throw bad("Payment not confirmed by provider");
  return true;
}
export function verifyWebhook(rawBody: Buffer, signature: string) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  const exp = crypto.createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return safeEqualHex(exp, signature || "");
}
export async function providerRefund(paymentId: string, amount: number, testMode: boolean) {
  if (testMode) return `test_refund_${crypto.randomBytes(6).toString("hex")}`;
  const r: any = await rzp().payments.refund(paymentId, { amount });
  return r.id as string;
}
