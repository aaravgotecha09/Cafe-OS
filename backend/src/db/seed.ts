import { sql } from "drizzle-orm";
import { db, pool, schema as s } from "./index";
import { hashPassword, randomToken } from "../utils/crypto";
import { CATEGORIES, INVENTORY, PRODUCTS, RECIPES, STATIONS } from "./seed-data";

const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const rnd = (n: number) => Math.floor(Math.random() * n);

export async function seedDemo(opts: { reset?: boolean; password?: string; withHistory?: boolean } = {}) {
  const password = opts.password ?? process.env.DEMO_PASSWORD ?? (process.env.NODE_ENV === "production" ? randomToken(8) : "Demo@12345");
  if (opts.reset) await db.execute(sql`truncate table restaurants, users cascade`);
  const existing = await db.select().from(s.restaurants).limit(1);
  if (existing.length) { console.log("Database already seeded — skipping (use SEED_RESET=true to reset in development)"); return null; }
  const hash = await hashPassword(password);
  const [rest] = await db.insert(s.restaurants).values({ name: "ORANGE & OAK CAFE", slug: "orange-oak", address: "12, Linking Road, Bandra West, Mumbai 400050", phone: "+91 22 5555 0142", email: "hello@orangeandoak.example", taxPercent: "5.00", serviceChargePercent: "0.00",
    settings: { wifi: { ssid: "OrangeOak-Guest", password: "oakbrew2026", security: "WPA", instructions: "Open Wi-Fi settings, choose OrangeOak-Guest and enter the password." }, hours: { "Mon-Sun": "11:00–21:00" }, notifications: { sound: true, email: true } } }).returning();
  const rid = rest.id;
  const [branch] = await db.insert(s.branches).values({ restaurantId: rid, name: "Bandra (main)", address: rest.address }).returning();
  const stations = await db.insert(s.kitchenStations).values(STATIONS.map(([name, code]) => ({ restaurantId: rid, name, code }))).returning();
  const st = (code: string) => stations.find((x) => x.code === code)!.id;
  const cats = await db.insert(s.categories).values(CATEGORIES.map((name, i) => ({ restaurantId: rid, name, slug: slug(name), sortOrder: i }))).returning();
  const cat = (n: string) => cats.find((c) => c.name === n)!;

  const prods = await db.insert(s.products).values(PRODUCTS.map(([c, name, price, diet, station, prep, tags, allergens, description]) => ({
    restaurantId: rid, categoryId: cat(c).id, stationId: st(station), name, slug: slug(name), description, price: price * 100, diet, vegan: /Americano|Espresso|Lemonade|Mojito|Orange|Watermelon|Fries|Green Tea|Peach/.test(name), jain: /Lemonade|Mojito|Juice|Tea|Espresso|Americano/.test(name),
    spiceLevel: /Arrabbiata|Peri|Tikka|Masala|Wings/.test(name) ? 2 : 0, portion: /Pizza/.test(name) ? "Serves 1–2" : "1 serving", prepMinutes: prep, calories: 120 + rnd(520), allergens, ingredients: description.replace(/\.$/, "").split(/,| and /).map((x) => x.trim()).filter(Boolean).slice(0, 5),
    tags, imageUrl: `/food/${slug(c)}.svg`,
    discountPrice: name === "Masala Chai" ? 79 * 100 : name === "Peri Peri Fries" ? 139 * 100 : null,
  }))).returning();

  // variants & customizations
  const byCat = (n: string) => PRODUCTS.filter((p) => p[0] === n).map((p) => prods.find((x) => x.name === p[1])!);
  for (const p of [...byCat("Coffee"), ...byCat("Cold Beverages").filter((x) => x.name === "Cold Coffee")]) {
    if (p.name === "Espresso") continue;
    await db.insert(s.productVariants).values([{ productId: p.id, name: "Small", priceDelta: -30 * 100 / 10 * 1, isDefault: false }, { productId: p.id, name: "Medium", priceDelta: 0, isDefault: true }, { productId: p.id, name: "Large", priceDelta: 40 * 100 / 10 * 1 }].map((v) => ({ ...v, priceDelta: v.name === "Small" ? -3000 / 10 : v.name === "Large" ? 4000 / 10 : 0 })));
    const [milk] = await db.insert(s.customizationGroups).values({ productId: p.id, name: "Milk", required: true }).returning();
    if (!/Americano/.test(p.name)) await db.insert(s.customizationOptions).values([{ groupId: milk.id, name: "Regular milk", priceDelta: 0 }, { groupId: milk.id, name: "Oat milk", priceDelta: 5000 }, { groupId: milk.id, name: "Almond milk", priceDelta: 4000 }]);
    else await db.delete(s.customizationGroups).where(sql`id = ${milk.id}`);
    const [ex] = await db.insert(s.customizationGroups).values({ productId: p.id, name: "Extras", multi: true }).returning();
    await db.insert(s.customizationOptions).values([{ groupId: ex.id, name: "Extra espresso shot", priceDelta: 5000 }, { groupId: ex.id, name: "Sugar-free", priceDelta: 0 }, { groupId: ex.id, name: "Extra hot", priceDelta: 0 }, { groupId: ex.id, name: "Less foam", priceDelta: 0 }]);
  }
  for (const p of byCat("Pizza")) {
    await db.insert(s.productVariants).values([{ productId: p.id, name: "Regular 8\"", priceDelta: 0, isDefault: true }, { productId: p.id, name: "Medium 10\"", priceDelta: 9000 }, { productId: p.id, name: "Large 12\"", priceDelta: 18000 }]);
    const mk = async (name: string, required: boolean, multi: boolean, opts: [string, number][]) => { const [g] = await db.insert(s.customizationGroups).values({ productId: p.id, name, required, multi }).returning(); await db.insert(s.customizationOptions).values(opts.map(([n, d]) => ({ groupId: g.id, name: n, priceDelta: d * 100 }))); };
    await mk("Crust", true, false, [["Classic hand-tossed", 0], ["Thin crust", 0], ["Cheese burst", 70]]);
    await mk("Cheese", false, false, [["Regular cheese", 0], ["Extra cheese", 50]]);
    await mk("Toppings", false, true, [["Olives", 30], ["Jalapeños", 30], ["Mushrooms", 40], ["Sweet corn", 30]]);
    await mk("Extra sauces", false, true, [["Chilli flakes & oregano", 0], ["Garlic dip", 25], ["Peri peri dip", 25]]);
    await mk("Spice level", false, false, [["Mild", 0], ["Medium", 0], ["Hot", 0]]);
  }
  for (const p of [...byCat("Pasta"), ...byCat("Burgers"), ...byCat("Sandwiches")]) {
    const [g] = await db.insert(s.customizationGroups).values({ productId: p.id, name: "Add-ons", multi: true }).returning();
    await db.insert(s.customizationOptions).values([{ groupId: g.id, name: "Extra cheese", priceDelta: 4000 }, { groupId: g.id, name: "Add fries", priceDelta: 6000 }, { groupId: g.id, name: "Extra spicy", priceDelta: 0 }]);
  }
  for (const p of byCat("Smoothies")) await db.insert(s.productVariants).values([{ productId: p.id, name: "Regular", priceDelta: 0, isDefault: true }, { productId: p.id, name: "Large", priceDelta: 5000 }]);

  // inventory & recipes
  const inv = await db.insert(s.inventoryItems).values(INVENTORY.map(([name, unit, qty, min, supplier, price]) => ({ restaurantId: rid, name, unit, quantity: String(qty), minStock: String(min), supplier, purchasePrice: price * 100, expiryDate: new Date(Date.now() + (7 + rnd(60)) * 86400000).toISOString().slice(0, 10) }))).returning();
  await db.insert(s.stockMovements).values(inv.map((i) => ({ inventoryItemId: i.id, delta: i.quantity, reason: "INITIAL" })));
  for (const [pn, parts] of Object.entries(RECIPES)) { const p = prods.find((x) => x.name === pn)!; await db.insert(s.recipeIngredients).values(parts.map(([n, q]) => ({ productId: p.id, inventoryItemId: inv.find((i) => i.name === n)!.id, quantity: String(q) }))); }

  // tables: 20 in a 5x4 grid
  const tables = await db.insert(s.cafeTables).values(Array.from({ length: 20 }, (_, i) => ({ restaurantId: rid, branchId: branch.id, number: i + 1, capacity: [2, 4, 4, 6][i % 4], location: i < 12 ? "Main hall" : i < 16 ? "Patio" : "Window bar", posX: (i % 5) * 150 + 20, posY: Math.floor(i / 5) * 130 + 20 }))).returning();

  // users
  const mk = (name: string, email: string, role: any, extra: object = {}) => ({ restaurantId: rid, branchId: branch.id, name, email, passwordHash: hash, role, ...extra });
  const users = await db.insert(s.users).values([
    mk("Aarav Mehta", "owner@orangeoak.test", "RESTAURANT_OWNER"), mk("Meera Shah", "manager@orangeoak.test", "MANAGER"),
    mk("Rohan Patil", "waiter1@orangeoak.test", "WAITER", { section: "Main hall" }), mk("Sana Khan", "waiter2@orangeoak.test", "WAITER", { section: "Patio" }),
    mk("Chef Imran", "kitchen@orangeoak.test", "KITCHEN_STAFF", { station: "HOT" }), mk("Barista Neha", "barista@orangeoak.test", "KITCHEN_STAFF", { station: "COFFEE" }), mk("Karan Joshi", "cashier@orangeoak.test", "CASHIER"),
  ]).returning();
  await db.update(s.cafeTables).set({ assignedWaiterId: users[2].id }).where(sql`number <= 12`);
  await db.update(s.cafeTables).set({ assignedWaiterId: users[3].id }).where(sql`number > 12`);

  // coupons
  await db.insert(s.coupons).values([
    { restaurantId: rid, code: "WELCOME10", type: "PERCENT", value: 10, minOrder: 20000, maxDiscount: 15000, firstOrderOnly: true },
    { restaurantId: rid, code: "FLAT50", type: "FIXED", value: 5000, minOrder: 30000 },
    { restaurantId: rid, code: "HAPPYHOUR", type: "PERCENT", value: 15, minOrder: 15000, maxDiscount: 10000, startHour: 15, endHour: 18 },
    { restaurantId: rid, code: "GOLD20", type: "PERCENT", value: 20, minOrder: 25000, maxDiscount: 20000, minTier: "GOLD" },
    { restaurantId: rid, code: "BOGOCOFFEE", type: "BOGO", bogoProductId: prods.find((p) => p.name === "Cappuccino")!.id, perCustomerLimit: 5 },
  ]);

  // customers + loyalty
  const custs = await db.insert(s.customers).values([
    { restaurantId: rid, name: "Priya Nair", phone: "+919800000001", email: "priya@example.test", birthday: "03-14", referralCode: "PRIYA1", consentPersonalization: true },
    { restaurantId: rid, name: "Vikram Rao", phone: "+919800000002", email: "vikram@example.test", birthday: "09-02", referralCode: "VIKRM2", consentPersonalization: true },
    { restaurantId: rid, name: "Anaya Iyer", phone: "+919800000003", referralCode: "ANAYA3" },
  ]).returning();
  const accs = await db.insert(s.loyaltyAccounts).values([{ customerId: custs[0].id, restaurantId: rid, points: 640, lifetimePoints: 640, tier: "SILVER" }, { customerId: custs[1].id, restaurantId: rid, points: 2150, lifetimePoints: 2150, tier: "GOLD" }, { customerId: custs[2].id, restaurantId: rid, points: 80, lifetimePoints: 80 }]).returning();
  await db.insert(s.loyaltyTransactions).values([{ accountId: accs[0].id, points: 640, kind: "BONUS", refKey: "seed:1", note: "Opening balance" }, { accountId: accs[1].id, points: 2150, kind: "BONUS", refKey: "seed:2", note: "Opening balance" }, { accountId: accs[2].id, points: 80, kind: "REFERRAL", refKey: "seed:3", note: "Welcome bonus" }]);

  // reservations
  const tomorrow = (h: number) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d; };
  await db.insert(s.reservations).values([{ restaurantId: rid, tableId: tables[3].id, name: "Rhea Kapoor", phone: "+919811100001", partySize: 4, startsAt: tomorrow(13) }, { restaurantId: rid, tableId: tables[8].id, name: "Dev Malhotra", phone: "+919811100002", partySize: 6, startsAt: tomorrow(19) }]);

  // historical paid orders for analytics (real rows; created directly so history spans 14 days)
  if (opts.withHistory !== false) {
    for (let n = 0; n < 70; n++) {
      const daysAgo = rnd(14), hour = [9, 11, 12, 13, 13, 14, 16, 17, 18, 19, 20][rnd(11)] + 0, when = new Date(Date.now() - daysAgo * 86400000); when.setHours(hour, rnd(60), 0, 0);
      const t = tables[rnd(20)], cust = rnd(3) === 0 ? custs[rnd(3)] : null;
      const chosen = Array.from({ length: 1 + rnd(3) }, () => prods[rnd(prods.length)]);
      await db.transaction(async (tx) => {
        const [ts] = await tx.insert(s.tableSessions).values({ restaurantId: rid, tableId: t.id, openedAt: when, closedAt: new Date(+when + 50 * 60000) }).returning();
        const [cs] = await tx.insert(s.customerSessions).values({ tableSessionId: ts.id, customerId: cust?.id, displayName: cust?.name ?? "Guest", tokenHash: randomToken(16) }).returning();
        const lines = chosen.map((p) => ({ p, q: 1 + rnd(2) })); const subtotal = lines.reduce((a, l) => a + (l.p.discountPrice ?? l.p.price) * l.q, 0); const tax = Math.round(subtotal * 0.05); const total = subtotal + tax;
        const [o] = await tx.insert(s.orders).values({ restaurantId: rid, orderNumber: `OO-H${n.toString().padStart(4, "0")}`, tableId: t.id, tableSessionId: ts.id, customerSessionId: cs.id, customerId: cust?.id, status: "COMPLETED", subtotal, tax, total, paymentStatus: "PAID", createdAt: when, updatedAt: when, etaMinutes: 12, loyaltyAwarded: true }).returning();
        const items = await tx.insert(s.orderItems).values(lines.map((l) => ({ orderId: o.id, productId: l.p.id, stationId: l.p.stationId, name: l.p.name, quantity: l.q, unitPrice: l.p.discountPrice ?? l.p.price, lineTotal: (l.p.discountPrice ?? l.p.price) * l.q, allergens: l.p.allergens, ready: true, served: true }))).returning();
        const stages: [string, number][] = [["PLACED", 0], ["CONFIRMED", 1], ["SENT_TO_KITCHEN", 2], ["PREPARING", 4], ["READY", 4 + 6 + rnd(10)], ["SERVED", 20], ["COMPLETED", 45]];
        await tx.insert(s.orderStatusHistory).values(stages.map(([status, m]) => ({ orderId: o.id, status: status as any, createdAt: new Date(+when + m * 60000) })));
        const stationIds = [...new Set(items.map((i) => i.stationId))];
        await tx.insert(s.kitchenTickets).values(stationIds.map((stationId) => ({ orderId: o.id, stationId, status: "COMPLETED" as const, startedAt: new Date(+when + 4 * 60000), readyAt: new Date(+when + (8 + rnd(10)) * 60000) })));
        const [b] = await tx.insert(s.bills).values({ restaurantId: rid, tableSessionId: ts.id, subtotal, discount: 0, tax, serviceCharge: 0, total, paidAmount: total, status: "PAID" }).returning();
        const tip = rnd(3) === 0 ? Math.round(total * 0.1) : 0;
        await tx.insert(s.payments).values({ restaurantId: rid, billId: b.id, amount: total, tip, method: (["UPI", "UPI", "CARD", "CASH", "ONLINE"] as const)[rnd(5)], status: "PAID", provider: "seed", testMode: true, createdAt: when, paidAt: new Date(+when + 45 * 60000) });
        if (rnd(2) === 0) await tx.insert(s.reviews).values({ restaurantId: rid, orderId: o.id, customerId: cust?.id, food: 3 + rnd(3), service: 3 + rnd(3), ambience: 4 + rnd(2), cleanliness: 4 + rnd(2), overall: 3 + rnd(3), comment: ["Lovely coffee!", "Great ambience", "Quick service", "Pizza was fantastic", null][rnd(5)] });
      });
    }
  }
  return { password, restaurantId: rid, tables, users, prods };
}

if (require.main === module) {
  (async () => {
    const dev = process.env.NODE_ENV !== "production";
    if (!dev && process.env.SEED_DEMO !== "true") { console.error("Refusing to seed demo data in production (set SEED_DEMO=true to override)."); process.exit(1); }
    const r = await seedDemo({ reset: dev && process.env.SEED_RESET === "true" });
    if (r) console.log(`Seeded ${r.tables.length} tables, ${r.prods.length} products, ${r.users.length} staff accounts.\nDemo password: ${r.password}  (accounts: owner@, manager@, waiter1@, waiter2@, kitchen@, barista@, cashier@ orangeoak.test)`);
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
