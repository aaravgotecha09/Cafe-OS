import { eq, inArray, sql } from "drizzle-orm";
import { db, schema as s, Executor } from "../db";
import { emitTo, rooms } from "../sockets";

/** Deduct recipe quantities for an order (once). Flags products unavailable when stock hits minimum. */
export async function consumeForOrder(orderId: string, userId: string | null, ex: Executor) {
  const [o] = await ex.select().from(s.orders).where(eq(s.orders.id, orderId)).for("update");
  if (!o || o.inventoryConsumed) return [];
  const items = await ex.select().from(s.orderItems).where(eq(s.orderItems.orderId, orderId));
  const pids = [...new Set(items.map((i) => i.productId))];
  if (!pids.length) return [];
  const recipes = await ex.select().from(s.recipeIngredients).where(inArray(s.recipeIngredients.productId, pids));
  const need = new Map<string, number>();
  for (const r of recipes) for (const it of items.filter((i) => i.productId === r.productId)) need.set(r.inventoryItemId, (need.get(r.inventoryItemId) || 0) + Number(r.quantity) * it.quantity);
  const low: string[] = [];
  for (const [invId, qty] of need) {
    const [inv] = await ex.update(s.inventoryItems).set({ quantity: sql`${s.inventoryItems.quantity} - ${qty}` }).where(eq(s.inventoryItems.id, invId)).returning();
    await ex.insert(s.stockMovements).values({ inventoryItemId: invId, delta: String(-qty), reason: "ORDER", orderId, userId });
    if (Number(inv.quantity) <= Number(inv.minStock)) low.push(inv.name);
    await refreshAvailability(inv.id, ex);
  }
  await ex.update(s.orders).set({ inventoryConsumed: true }).where(eq(s.orders.id, orderId));
  if (low.length) emitTo(rooms.role(o.restaurantId, "MANAGER"), "notification:new", { title: "Low stock", body: low.join(", "), kind: "inventory" });
  return low;
}
/** Auto-disable products whose ingredients are at/below minimum; re-enable ones we auto-disabled once restocked. */
export async function refreshAvailability(inventoryItemId: string, ex: Executor) {
  const [inv] = await ex.select().from(s.inventoryItems).where(eq(s.inventoryItems.id, inventoryItemId));
  const rows = await ex.select({ pid: s.recipeIngredients.productId }).from(s.recipeIngredients).where(eq(s.recipeIngredients.inventoryItemId, inventoryItemId));
  if (!rows.length) return;
  const pids = rows.map((r) => r.pid);
  if (Number(inv.quantity) <= Number(inv.minStock)) await ex.update(s.products).set({ available: false, autoUnavailable: true }).where(inArray(s.products.id, pids));
  else for (const pid of pids) {
    // Only re-enable if every ingredient of the product is above minimum
    const [{ low }] = await ex.select({ low: sql<number>`count(*) filter (where ${s.inventoryItems.quantity} <= ${s.inventoryItems.minStock})` })
      .from(s.recipeIngredients).innerJoin(s.inventoryItems, eq(s.inventoryItems.id, s.recipeIngredients.inventoryItemId)).where(eq(s.recipeIngredients.productId, pid));
    if (Number(low) === 0) await ex.update(s.products).set({ available: true, autoUnavailable: false }).where(sql`${s.products.id} = ${pid} and ${s.products.autoUnavailable} = true`);
  }
}
export async function adjustStock(rid: string, invId: string, delta: number, reason: string, userId: string | null) {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(s.inventoryItems).where(eq(s.inventoryItems.id, invId)).for("update");
    if (!inv || inv.restaurantId !== rid) return null;
    if (Number(inv.quantity) + delta < 0) throw new Error("NEGATIVE_STOCK");
    const [u] = await tx.update(s.inventoryItems).set({ quantity: sql`${s.inventoryItems.quantity} + ${delta}` }).where(eq(s.inventoryItems.id, invId)).returning();
    await tx.insert(s.stockMovements).values({ inventoryItemId: invId, delta: String(delta), reason, userId });
    await refreshAvailability(invId, tx);
    return u;
  });
}
