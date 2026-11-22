import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema as s, Executor } from "../db";
import { bad } from "../utils/errors";
import { TIER_RANK, getRules } from "./loyalty";

export const cartLineSchema = z.object({
  productId: z.string().uuid(), variantId: z.string().uuid().optional().nullable(), optionIds: z.array(z.string().uuid()).default([]),
  quantity: z.number().int().min(1).max(50), instructions: z.string().max(300).optional(),
});
export type CartLine = z.infer<typeof cartLineSchema>;
export type PricedLine = { productId: string; stationId: string | null; name: string; variantName: string | null; quantity: number; unitPrice: number; lineTotal: number; customizations: { group: string; option: string; priceDelta: number }[]; allergens: string[]; instructions?: string; prepMinutes: number };
export type Priced = { lines: PricedLine[]; subtotal: number; discount: number; couponDiscount: number; pointsDiscount: number; tax: number; serviceCharge: number; total: number; etaMinutes: number; couponId: string | null; couponCode: string | null; pointsRedeemed: number };

export async function priceCart(rid: string, lines: CartLine[], opts: { couponCode?: string; customerId?: string | null; redeemPoints?: number } = {}, ex: Executor = db): Promise<Priced> {
  if (!lines.length) throw bad("Cart is empty");
  const pids = [...new Set(lines.map((l) => l.productId))];
  const prods = await ex.select().from(s.products).where(and(eq(s.products.restaurantId, rid), inArray(s.products.id, pids)));
  const byId = new Map(prods.map((p) => [p.id, p]));
  const variants = await ex.select().from(s.productVariants).where(inArray(s.productVariants.productId, pids));
  const groups = await ex.select().from(s.customizationGroups).where(inArray(s.customizationGroups.productId, pids));
  const options = groups.length ? await ex.select().from(s.customizationOptions).where(inArray(s.customizationOptions.groupId, groups.map((g) => g.id))) : [];
  const priced: PricedLine[] = [];
  for (const l of lines) {
    const p = byId.get(l.productId);
    if (!p) throw bad("Product not found");
    if (!p.available) throw bad(`${p.name} is currently unavailable`);
    const pv = variants.filter((v) => v.productId === p.id);
    const variant = l.variantId ? pv.find((v) => v.id === l.variantId) : pv.find((v) => v.isDefault);
    if (l.variantId && !variant) throw bad(`Invalid variant for ${p.name}`);
    const pg = groups.filter((g) => g.productId === p.id);
    const chosen = l.optionIds.map((oid) => { const o = options.find((x) => x.id === oid); if (!o || !pg.some((g) => g.id === o.groupId)) throw bad(`Invalid option for ${p.name}`); return o; });
    if (new Set(l.optionIds).size !== l.optionIds.length) throw bad("Duplicate options");
    for (const g of pg) {
      const n = chosen.filter((o) => o.groupId === g.id).length;
      if (g.required && n === 0) throw bad(`${g.name} is required for ${p.name}`);
      if (!g.multi && n > 1) throw bad(`Select only one ${g.name}`);
      if (g.maxSelect && n > g.maxSelect) throw bad(`Too many ${g.name} selections`);
    }
    const cust = chosen.map((o) => ({ group: pg.find((g) => g.id === o.groupId)!.name, option: o.name, priceDelta: o.priceDelta }));
    const unit = (p.discountPrice ?? p.price) + (variant?.priceDelta || 0) + cust.reduce((a, c) => a + c.priceDelta, 0);
    priced.push({ productId: p.id, stationId: p.stationId, name: p.name, variantName: variant?.name ?? null, quantity: l.quantity, unitPrice: unit, lineTotal: unit * l.quantity, customizations: cust, allergens: p.allergens, instructions: l.instructions, prepMinutes: p.prepMinutes });
  }
  const subtotal = priced.reduce((a, l) => a + l.lineTotal, 0);
  let couponDiscount = 0, couponId: string | null = null, couponCode: string | null = null;
  if (opts.couponCode) {
    const r = await evaluateCoupon(rid, opts.couponCode, priced, subtotal, opts.customerId ?? null, ex);
    couponDiscount = r.discount; couponId = r.id; couponCode = r.code;
  }
  let pointsDiscount = 0, pointsRedeemed = 0;
  if (opts.redeemPoints && opts.redeemPoints > 0) {
    if (!opts.customerId) throw bad("Identify yourself to redeem points");
    const [acc] = await ex.select().from(s.loyaltyAccounts).where(eq(s.loyaltyAccounts.customerId, opts.customerId));
    if (!acc || acc.points < opts.redeemPoints) throw bad("Not enough points");
    const rules = await getRules(rid, ex);
    const maxPts = Math.floor((subtotal - couponDiscount) / rules.pointValuePaise);
    pointsRedeemed = Math.min(opts.redeemPoints, maxPts);
    pointsDiscount = pointsRedeemed * rules.pointValuePaise;
  }
  const discount = couponDiscount + pointsDiscount;
  const [r] = await ex.select().from(s.restaurants).where(eq(s.restaurants.id, rid));
  const taxable = subtotal - discount;
  const tax = Math.round((taxable * Number(r.taxPercent)) / 100);
  const serviceCharge = Math.round((taxable * Number(r.serviceChargePercent)) / 100);
  const maxPrep = Math.max(...priced.map((l) => l.prepMinutes));
  const eta = maxPrep + Math.ceil(priced.reduce((a, l) => a + l.quantity, 0) / 4);
  return { lines: priced, subtotal, discount, couponDiscount, pointsDiscount, tax, serviceCharge, total: taxable + tax + serviceCharge, etaMinutes: eta, couponId, couponCode, pointsRedeemed };
}

export async function evaluateCoupon(rid: string, code: string, lines: PricedLine[], subtotal: number, customerId: string | null, ex: Executor) {
  const [c] = await ex.select().from(s.coupons).where(and(eq(s.coupons.restaurantId, rid), eq(s.coupons.code, code.trim().toUpperCase())));
  if (!c || !c.active) throw bad("Invalid coupon");
  const now = new Date();
  if (c.startsAt && now < c.startsAt) throw bad("Coupon not active yet");
  if (c.endsAt && now > c.endsAt) throw bad("Coupon expired");
  if (c.startHour != null && c.endHour != null) {
    const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(now)) % 24;
    if (h < c.startHour || h >= c.endHour) throw bad(`Coupon valid only ${c.startHour}:00–${c.endHour}:00`);
  }
  if (subtotal < c.minOrder) throw bad(`Minimum order ₹${c.minOrder / 100} required`);
  if (c.usageLimit != null) {
    const [{ n }] = await ex.select({ n: sql<number>`count(*)` }).from(s.couponRedemptions).where(eq(s.couponRedemptions.couponId, c.id));
    if (Number(n) >= c.usageLimit) throw bad("Coupon usage limit reached");
  }
  if (c.perCustomerLimit != null && customerId) {
    const [{ n }] = await ex.select({ n: sql<number>`count(*)` }).from(s.couponRedemptions).where(and(eq(s.couponRedemptions.couponId, c.id), eq(s.couponRedemptions.customerId, customerId)));
    if (Number(n) >= c.perCustomerLimit) throw bad("You have already used this coupon");
  }
  if (c.firstOrderOnly) {
    if (!customerId) throw bad("Identify yourself to use a first-order coupon");
    const [{ n }] = await ex.select({ n: sql<number>`count(*)` }).from(s.orders).where(and(eq(s.orders.customerId, customerId), notInArray(s.orders.status, ["CANCELLED", "REJECTED"])));
    if (Number(n) > 0) throw bad("Coupon is for first orders only");
  }
  if (c.minTier) {
    if (!customerId) throw bad("Identify yourself to use this coupon");
    const [acc] = await ex.select().from(s.loyaltyAccounts).where(eq(s.loyaltyAccounts.customerId, customerId));
    if (!acc || TIER_RANK[acc.tier] < TIER_RANK[c.minTier]) throw bad(`Requires ${c.minTier} membership`);
  }
  let d = 0;
  if (c.type === "PERCENT") d = Math.round((subtotal * c.value) / 100);
  else if (c.type === "FIXED" || c.type === "COMBO") d = c.value;
  else if (c.type === "BOGO") {
    const qty = lines.filter((l) => l.productId === c.bogoProductId).reduce((a, l) => a + l.quantity, 0);
    const unit = lines.find((l) => l.productId === c.bogoProductId)?.unitPrice || 0;
    d = Math.floor(qty / 2) * unit;
    if (d === 0) throw bad("Add two eligible items to use this offer");
  }
  if (c.maxDiscount != null) d = Math.min(d, c.maxDiscount);
  return { id: c.id, code: c.code, discount: Math.min(d, subtotal) };
}
