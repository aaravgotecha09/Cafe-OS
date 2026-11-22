import PDFDocument from "pdfkit";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { Resend } from "resend";
import { db, schema as s } from "../db";
import { env } from "../config/env";
import { notFound } from "../utils/errors";

const inr = (p: number) => `Rs. ${(p / 100).toFixed(2)}`;
export async function receiptData(rid: string, billId: string) {
  const [bill] = await db.select().from(s.bills).where(and(eq(s.bills.id, billId), eq(s.bills.restaurantId, rid)));
  if (!bill) throw notFound("Bill not found");
  const [rest] = await db.select().from(s.restaurants).where(eq(s.restaurants.id, rid));
  const [ts] = await db.select().from(s.tableSessions).where(eq(s.tableSessions.id, bill.tableSessionId));
  const [table] = await db.select().from(s.cafeTables).where(eq(s.cafeTables.id, ts.tableId));
  const orders = await db.select().from(s.orders).where(and(eq(s.orders.tableSessionId, bill.tableSessionId), notInArray(s.orders.status, ["CANCELLED", "REJECTED"])));
  const items = orders.length ? await db.select().from(s.orderItems).where(inArray(s.orderItems.orderId, orders.map((o) => o.id))) : [];
  const payments = (await db.select().from(s.payments).where(eq(s.payments.billId, bill.id))).filter((p) => p.status === "PAID" || p.status === "PARTIALLY_REFUNDED" || p.status === "REFUNDED");
  return { bill, rest, table, orders, items, payments };
}
export async function buildReceiptPdf(rid: string, billId: string): Promise<Buffer> {
  const d = await receiptData(rid, billId);
  const doc = new PDFDocument({ size: "A5", margin: 36 });
  const chunks: Buffer[] = []; doc.on("data", (c) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on("end", () => r(Buffer.concat(chunks))));
  const test = d.payments.some((p) => p.testMode);
  doc.rect(0, 0, doc.page.width, 64).fill("#F97316");
  doc.fillColor("#fff").fontSize(18).text(d.rest.name.toUpperCase(), 36, 20);
  doc.fillColor("#1C1917").fontSize(8).moveDown(2.5);
  if (d.rest.address) doc.text(d.rest.address); if (d.rest.phone) doc.text(d.rest.phone);
  doc.moveDown(0.5).fontSize(9).text(`Receipt #${d.bill.id.slice(0, 8).toUpperCase()}   Table ${d.table.number}`).text(`Orders: ${d.orders.map((o) => o.orderNumber).join(", ")}`).text(`Date: ${(d.payments[0]?.paidAt ?? d.bill.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
  doc.moveDown(0.5).moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).stroke("#E7E5E4").moveDown(0.5);
  for (const it of d.items) {
    doc.fontSize(9).text(`${it.quantity} x ${it.name}${it.variantName ? " (" + it.variantName + ")" : ""}`, { continued: true, width: 220 }).text(inr(it.lineTotal), { align: "right" });
    const c = (it.customizations as any[]).map((x) => x.option).join(", "); if (c) doc.fontSize(7).fillColor("#78716C").text(`   ${c}`).fillColor("#1C1917");
  }
  doc.moveDown(0.5).moveTo(36, doc.y).lineTo(doc.page.width - 36, doc.y).stroke("#E7E5E4").moveDown(0.5);
  const row = (l: string, v: string, bold = false) => { doc.fontSize(bold ? 11 : 9).font(bold ? "Helvetica-Bold" : "Helvetica").text(l, { continued: true }).text(v, { align: "right" }); };
  row("Subtotal", inr(d.bill.subtotal)); if (d.bill.discount) row("Discount", "-" + inr(d.bill.discount)); row("Tax", inr(d.bill.tax)); if (d.bill.serviceCharge) row("Service charge", inr(d.bill.serviceCharge));
  const tip = d.payments.reduce((a, p) => a + p.tip, 0); if (tip) row("Tip", inr(tip));
  row("Total paid", inr(d.bill.total + tip), true);
  doc.font("Helvetica").moveDown(0.5).fontSize(8).fillColor("#78716C").text(`Payment: ${[...new Set(d.payments.map((p) => p.method))].join(", ") || "—"}`);
  if (test) doc.fillColor("#DC2626").fontSize(9).text("TEST MODE PAYMENT — NOT A VALID TAX INVOICE");
  doc.fillColor("#78716C").moveDown(1).text("Thank you for visiting!", { align: "center" });
  doc.end(); return done;
}
export async function sendReceiptEmail(rid: string, billId: string, to?: string) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "Email not configured (RESEND_API_KEY missing)" };
  const d = await receiptData(rid, billId);
  let email = to;
  if (!email) {
    const o = d.orders.find((x) => x.customerId);
    if (o?.customerId) { const [c] = await db.select().from(s.customers).where(eq(s.customers.id, o.customerId)); email = c?.email ?? undefined; }
  }
  if (!email) return { sent: false, reason: "No email address" };
  const pdf = await buildReceiptPdf(rid, billId);
  const r = await new Resend(env.RESEND_API_KEY).emails.send({ from: env.EMAIL_FROM, to: email, subject: `Your receipt from ${d.rest.name}`, html: `<p>Thank you for dining with <b>${d.rest.name}</b>. Your receipt is attached.</p>`, attachments: [{ filename: "receipt.pdf", content: pdf }] });
  return { sent: !r.error, reason: r.error?.message };
}
