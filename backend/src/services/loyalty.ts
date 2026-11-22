import { and, eq, sql } from "drizzle-orm";
import { db, schema as s, Executor } from "../db";

export const DEFAULT_LOYALTY = { pointsPerRupee: 0.1, pointValuePaise: 100, tiers: { SILVER: 500, GOLD: 2000, PLATINUM: 5000 }, multiplier: { BRONZE: 1, SILVER: 1.1, GOLD: 1.25, PLATINUM: 1.5 }, referralBonus: 100, birthdayBonus: 150, gameDailyCap: 50 };
export type LoyaltyRules = typeof DEFAULT_LOYALTY;
export const TIER_RANK: Record<string, number> = { BRONZE: 0, SILVER: 1, GOLD: 2, PLATINUM: 3 };

export async function getRules(rid: string, ex: Executor = db): Promise<LoyaltyRules> {
  const [r] = await ex.select({ settings: s.restaurants.settings }).from(s.restaurants).where(eq(s.restaurants.id, rid));
  return { ...DEFAULT_LOYALTY, ...((r?.settings as any)?.loyalty || {}) };
}
export const tierFor = (lifetime: number, rules: LoyaltyRules) => lifetime >= rules.tiers.PLATINUM ? "PLATINUM" : lifetime >= rules.tiers.GOLD ? "GOLD" : lifetime >= rules.tiers.SILVER ? "SILVER" : "BRONZE";

export async function getOrCreateAccount(rid: string, customerId: string, ex: Executor = db) {
  await ex.insert(s.loyaltyAccounts).values({ customerId, restaurantId: rid }).onConflictDoNothing();
  const [a] = await ex.select().from(s.loyaltyAccounts).where(eq(s.loyaltyAccounts.customerId, customerId));
  return a;
}
/** Idempotent via (account, refKey) unique index. Returns true if a new transaction was written. */
export async function addPoints(rid: string, customerId: string, points: number, kind: string, refKey: string, note: string | undefined, ex: Executor) {
  const acc = await getOrCreateAccount(rid, customerId, ex);
  const ins = await ex.insert(s.loyaltyTransactions).values({ accountId: acc.id, points, kind, refKey, note }).onConflictDoNothing().returning({ id: s.loyaltyTransactions.id });
  if (!ins.length) return false;
  const rules = await getRules(rid, ex);
  const [u] = await ex.update(s.loyaltyAccounts).set({
    points: sql`${s.loyaltyAccounts.points} + ${points}`,
    lifetimePoints: sql`${s.loyaltyAccounts.lifetimePoints} + ${points > 0 && kind !== "REVERSAL" ? points : 0}`,
  }).where(eq(s.loyaltyAccounts.id, acc.id)).returning();
  const tier = tierFor(u.lifetimePoints, rules);
  if (tier !== u.tier) await ex.update(s.loyaltyAccounts).set({ tier }).where(eq(s.loyaltyAccounts.id, acc.id));
  return true;
}
/** Awards points only for PAID, non-cancelled orders; at most once per order. */
export async function awardForOrder(orderId: string, ex: Executor) {
  const [o] = await ex.select().from(s.orders).where(eq(s.orders.id, orderId)).for("update");
  if (!o || !o.customerId || o.loyaltyAwarded || o.paymentStatus !== "PAID" || ["CANCELLED", "REJECTED"].includes(o.status)) return 0;
  const rules = await getRules(o.restaurantId, ex);
  const acc = await getOrCreateAccount(o.restaurantId, o.customerId, ex);
  const pts = Math.floor((o.total / 100) * rules.pointsPerRupee * (rules.multiplier as any)[acc.tier]);
  if (pts > 0) await addPoints(o.restaurantId, o.customerId, pts, "EARN", `order:${o.id}`, `Order ${o.orderNumber}`, ex);
  await ex.update(s.orders).set({ loyaltyAwarded: true }).where(eq(s.orders.id, o.id));
  return pts;
}
export async function reverseForOrder(orderId: string, ex: Executor) {
  const [o] = await ex.select().from(s.orders).where(eq(s.orders.id, orderId));
  if (!o?.customerId) return;
  const [earn] = await ex.select().from(s.loyaltyTransactions).innerJoin(s.loyaltyAccounts, eq(s.loyaltyAccounts.id, s.loyaltyTransactions.accountId))
    .where(and(eq(s.loyaltyAccounts.customerId, o.customerId), eq(s.loyaltyTransactions.refKey, `order:${o.id}`)));
  if (earn) await addPoints(o.restaurantId, o.customerId, -earn.loyalty_transactions.points, "REVERSAL", `reverse:${o.id}`, `Refund ${o.orderNumber}`, ex);
}
