import { pgTable, pgEnum, uuid, text, integer, boolean, timestamp, jsonb, numeric, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const rid = () => uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" });

export const roleEnum = pgEnum("role", ["SUPER_ADMIN", "RESTAURANT_OWNER", "MANAGER", "WAITER", "KITCHEN_STAFF", "CASHIER", "CUSTOMER"]);
export const tableStatusEnum = pgEnum("table_status", ["AVAILABLE", "OCCUPIED", "RESERVED", "CLEANING"]);
export const orderStatusEnum = pgEnum("order_status", ["PLACED", "CONFIRMED", "SENT_TO_KITCHEN", "PREPARING", "READY", "SERVED", "COMPLETED", "REJECTED", "CANCELLED"]);
export const ticketStatusEnum = pgEnum("ticket_status", ["NEW", "ACCEPTED", "PREPARING", "READY", "COMPLETED"]);
export const requestTypeEnum = pgEnum("request_type", ["CALL_WAITER", "WATER", "NAPKINS", "CUTLERY", "BILL", "CLEANING", "ASSISTANCE", "CUSTOM"]);
export const requestStatusEnum = pgEnum("request_status", ["PENDING", "ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED"]);
export const paymentStatusEnum = pgEnum("payment_status", ["PENDING", "PAID", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"]);
export const paymentMethodEnum = pgEnum("payment_method", ["CASH", "UPI", "CARD", "NETBANKING", "WALLET", "ONLINE"]);
export const couponTypeEnum = pgEnum("coupon_type", ["PERCENT", "FIXED", "BOGO", "COMBO"]);

export const restaurants = pgTable("restaurants", {
  id: id(), name: text("name").notNull(), slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"), address: text("address"), phone: text("phone"), email: text("email"),
  currency: text("currency").notNull().default("INR"),
  taxPercent: numeric("tax_percent", { precision: 5, scale: 2 }).notNull().default("5.00"),
  serviceChargePercent: numeric("service_charge_percent", { precision: 5, scale: 2 }).notNull().default("0.00"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: createdAt(),
});

export const branches = pgTable("branches", {
  id: id(), restaurantId: rid(), name: text("name").notNull(), address: text("address"), createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(), restaurantId: uuid("restaurant_id").references(() => restaurants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  email: text("email").notNull(), passwordHash: text("password_hash").notNull(), name: text("name").notNull(),
  role: roleEnum("role").notNull(), station: text("station"), section: text("section"),
  active: boolean("active").notNull().default(true), available: boolean("available").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("users_email_uq").on(t.email), index("users_rest_idx").on(t.restaurantId, t.role)]);

export const refreshTokens = pgTable("refresh_tokens", {
  id: id(), userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }), createdAt: createdAt(),
});
export const passwordResets = pgTable("password_resets", {
  id: id(), userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const customers = pgTable("customers", {
  id: id(), restaurantId: rid(), name: text("name"), phone: text("phone"), email: text("email"),
  birthday: text("birthday"), referralCode: text("referral_code"), referredBy: uuid("referred_by"),
  consentPersonalization: boolean("consent_personalization").notNull().default(false),
  favourites: jsonb("favourites").notNull().default([]), createdAt: createdAt(),
}, (t) => [uniqueIndex("cust_phone_uq").on(t.restaurantId, t.phone), uniqueIndex("cust_ref_uq").on(t.referralCode)]);

export const cafeTables = pgTable("cafe_tables", {
  id: id(), restaurantId: rid(), branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  number: integer("number").notNull(), capacity: integer("capacity").notNull().default(4), location: text("location").default("Main hall"),
  status: tableStatusEnum("status").notNull().default("AVAILABLE"),
  posX: integer("pos_x").notNull().default(0), posY: integer("pos_y").notNull().default(0),
  assignedWaiterId: uuid("assigned_waiter_id").references(() => users.id, { onDelete: "set null" }),
  qrNonce: text("qr_nonce").notNull().default(sql`gen_random_uuid()::text`),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("tables_num_uq").on(t.restaurantId, t.number)]);

export const tableSessions = pgTable("table_sessions", {
  id: id(), restaurantId: rid(), tableId: uuid("table_id").notNull().references(() => cafeTables.id, { onDelete: "cascade" }),
  openedAt: createdAt(), closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [index("ts_table_idx").on(t.tableId, t.closedAt)]);

export const customerSessions = pgTable("customer_sessions", {
  id: id(), tableSessionId: uuid("table_session_id").notNull().references(() => tableSessions.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
  displayName: text("display_name"), tokenHash: text("token_hash").notNull().unique(), createdAt: createdAt(),
});

export const kitchenStations = pgTable("kitchen_stations", {
  id: id(), restaurantId: rid(), name: text("name").notNull(), code: text("code").notNull(),
}, (t) => [uniqueIndex("ks_code_uq").on(t.restaurantId, t.code)]);

export const categories = pgTable("categories", {
  id: id(), restaurantId: rid(), name: text("name").notNull(), slug: text("slug").notNull(),
  sortOrder: integer("sort_order").notNull().default(0), active: boolean("active").notNull().default(true),
}, (t) => [uniqueIndex("cat_slug_uq").on(t.restaurantId, t.slug)]);

export const products = pgTable("products", {
  id: id(), restaurantId: rid(), categoryId: uuid("category_id").notNull().references(() => categories.id),
  stationId: uuid("station_id").references(() => kitchenStations.id, { onDelete: "set null" }),
  name: text("name").notNull(), slug: text("slug").notNull(), description: text("description").default(""),
  imageUrl: text("image_url"), price: integer("price").notNull(), discountPrice: integer("discount_price"),
  diet: text("diet").notNull().default("VEG"),
  vegan: boolean("vegan").notNull().default(false), jain: boolean("jain").notNull().default(false),
  spiceLevel: integer("spice_level").notNull().default(0), portion: text("portion"),
  prepMinutes: integer("prep_minutes").notNull().default(10), calories: integer("calories"),
  allergens: text("allergens").array().notNull().default(sql`ARRAY[]::text[]`),
  ingredients: text("ingredients").array().notNull().default(sql`ARRAY[]::text[]`),
  available: boolean("available").notNull().default(true), autoUnavailable: boolean("auto_unavailable").notNull().default(false),
  tags: text("tags").array().notNull().default(sql`ARRAY[]::text[]`),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("prod_slug_uq").on(t.restaurantId, t.slug), index("prod_cat_idx").on(t.categoryId)]);

export const productVariants = pgTable("product_variants", {
  id: id(), productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(), priceDelta: integer("price_delta").notNull().default(0), isDefault: boolean("is_default").notNull().default(false),
});
export const customizationGroups = pgTable("customization_groups", {
  id: id(), productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(), required: boolean("required").notNull().default(false),
  multi: boolean("multi").notNull().default(false), maxSelect: integer("max_select"),
});
export const customizationOptions = pgTable("customization_options", {
  id: id(), groupId: uuid("group_id").notNull().references(() => customizationGroups.id, { onDelete: "cascade" }),
  name: text("name").notNull(), priceDelta: integer("price_delta").notNull().default(0),
});

export const inventoryItems = pgTable("inventory_items", {
  id: id(), restaurantId: rid(), name: text("name").notNull(), unit: text("unit").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull().default("0"),
  minStock: numeric("min_stock", { precision: 12, scale: 3 }).notNull().default("0"),
  supplier: text("supplier"), purchasePrice: integer("purchase_price"), expiryDate: text("expiry_date"),
}, (t) => [uniqueIndex("inv_name_uq").on(t.restaurantId, t.name)]);
export const recipeIngredients = pgTable("recipe_ingredients", {
  id: id(), productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  inventoryItemId: uuid("inventory_item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
}, (t) => [uniqueIndex("recipe_uq").on(t.productId, t.inventoryItemId)]);
export const stockMovements = pgTable("stock_movements", {
  id: id(), inventoryItemId: uuid("inventory_item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  delta: numeric("delta", { precision: 12, scale: 3 }).notNull(), reason: text("reason").notNull(),
  orderId: uuid("order_id"), userId: uuid("user_id"), createdAt: createdAt(),
});

export const coupons = pgTable("coupons", {
  id: id(), restaurantId: rid(), code: text("code").notNull(), type: couponTypeEnum("type").notNull(),
  value: integer("value").notNull().default(0),
  minOrder: integer("min_order").notNull().default(0), maxDiscount: integer("max_discount"),
  startsAt: timestamp("starts_at", { withTimezone: true }), endsAt: timestamp("ends_at", { withTimezone: true }),
  usageLimit: integer("usage_limit"), perCustomerLimit: integer("per_customer_limit").default(1),
  firstOrderOnly: boolean("first_order_only").notNull().default(false), minTier: text("min_tier"),
  bogoProductId: uuid("bogo_product_id"), active: boolean("active").notNull().default(true),
  startHour: integer("start_hour"), endHour: integer("end_hour"),
}, (t) => [uniqueIndex("coupon_code_uq").on(t.restaurantId, t.code)]);

export const orders = pgTable("orders", {
  id: id(), restaurantId: rid(), orderNumber: text("order_number").notNull(),
  tableId: uuid("table_id").notNull().references(() => cafeTables.id), tableSessionId: uuid("table_session_id").notNull().references(() => tableSessions.id),
  customerSessionId: uuid("customer_session_id").notNull().references(() => customerSessions.id),
  customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
  status: orderStatusEnum("status").notNull().default("PLACED"),
  subtotal: integer("subtotal").notNull(), discount: integer("discount").notNull().default(0), tax: integer("tax").notNull().default(0),
  serviceCharge: integer("service_charge").notNull().default(0), total: integer("total").notNull(),
  couponId: uuid("coupon_id").references(() => coupons.id), couponCode: text("coupon_code"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("PENDING"),
  customerName: text("customer_name"), notes: text("notes"), rejectReason: text("reject_reason"),
  assignedStaffId: uuid("assigned_staff_id").references(() => users.id, { onDelete: "set null" }),
  etaMinutes: integer("eta_minutes").notNull().default(10), inventoryConsumed: boolean("inventory_consumed").notNull().default(false),
  loyaltyAwarded: boolean("loyalty_awarded").notNull().default(false),
  createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("order_num_uq").on(t.restaurantId, t.orderNumber), index("order_status_idx").on(t.restaurantId, t.status), index("order_ts_idx").on(t.tableSessionId)]);

export const orderItems = pgTable("order_items", {
  id: id(), orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id), stationId: uuid("station_id").references(() => kitchenStations.id),
  name: text("name").notNull(), variantName: text("variant_name"), quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(), lineTotal: integer("line_total").notNull(),
  customizations: jsonb("customizations").notNull().default([]),
  allergens: text("allergens").array().notNull().default(sql`ARRAY[]::text[]`), instructions: text("instructions"),
  ready: boolean("ready").notNull().default(false), served: boolean("served").notNull().default(false),
}, (t) => [index("oi_order_idx").on(t.orderId)]);

export const orderStatusHistory = pgTable("order_status_history", {
  id: id(), orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  status: orderStatusEnum("status").notNull(), byUserId: uuid("by_user_id"), note: text("note"), createdAt: createdAt(),
});

export const kitchenTickets = pgTable("kitchen_tickets", {
  id: id(), orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  stationId: uuid("station_id").references(() => kitchenStations.id), status: ticketStatusEnum("status").notNull().default("NEW"),
  priority: integer("priority").notNull().default(0), notes: text("notes"), pickupRequested: boolean("pickup_requested").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }), readyAt: timestamp("ready_at", { withTimezone: true }), createdAt: createdAt(),
}, (t) => [uniqueIndex("kt_order_station_uq").on(t.orderId, t.stationId)]);

export const serviceRequests = pgTable("service_requests", {
  id: id(), restaurantId: rid(), tableId: uuid("table_id").notNull().references(() => cafeTables.id, { onDelete: "cascade" }),
  tableSessionId: uuid("table_session_id").references(() => tableSessions.id), type: requestTypeEnum("type").notNull(),
  message: text("message"), status: requestStatusEnum("status").notNull().default("PENDING"),
  assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(), acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }), completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [index("sr_status_idx").on(t.restaurantId, t.status)]);

export const bills = pgTable("bills", {
  id: id(), restaurantId: rid(), tableSessionId: uuid("table_session_id").notNull().references(() => tableSessions.id),
  subtotal: integer("subtotal").notNull(), discount: integer("discount").notNull(), tax: integer("tax").notNull(),
  serviceCharge: integer("service_charge").notNull(), total: integer("total").notNull(), paidAmount: integer("paid_amount").notNull().default(0),
  status: text("status").notNull().default("OPEN"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("bill_ts_uq").on(t.tableSessionId)]);

export const billSplits = pgTable("bill_splits", {
  id: id(), billId: uuid("bill_id").notNull().references(() => bills.id, { onDelete: "cascade" }),
  label: text("label").notNull(), amount: integer("amount").notNull(), itemIds: jsonb("item_ids").notNull().default([]),
  paid: boolean("paid").notNull().default(false), customerSessionId: uuid("customer_session_id"),
});

export const payments = pgTable("payments", {
  id: id(), restaurantId: rid(), billId: uuid("bill_id").notNull().references(() => bills.id), splitId: uuid("split_id").references(() => billSplits.id),
  amount: integer("amount").notNull(), tip: integer("tip").notNull().default(0),
  method: paymentMethodEnum("method").notNull(), status: paymentStatusEnum("status").notNull().default("PENDING"),
  provider: text("provider").notNull().default("razorpay"), providerOrderId: text("provider_order_id"), providerPaymentId: text("provider_payment_id"),
  idempotencyKey: text("idempotency_key"), testMode: boolean("test_mode").notNull().default(false),
  collectedBy: uuid("collected_by"), createdAt: createdAt(), paidAt: timestamp("paid_at", { withTimezone: true }),
}, (t) => [uniqueIndex("pay_idem_uq").on(t.billId, t.idempotencyKey), uniqueIndex("pay_provider_order_uq").on(t.providerOrderId)]);

export const refunds = pgTable("refunds", {
  id: id(), paymentId: uuid("payment_id").notNull().references(() => payments.id), amount: integer("amount").notNull(),
  reason: text("reason"), providerRefundId: text("provider_refund_id"), status: text("status").notNull().default("PROCESSED"), createdAt: createdAt(),
});

export const couponRedemptions = pgTable("coupon_redemptions", {
  id: id(), couponId: uuid("coupon_id").notNull().references(() => coupons.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }), customerId: uuid("customer_id"), discount: integer("discount").notNull(), createdAt: createdAt(),
}, (t) => [uniqueIndex("cr_order_uq").on(t.couponId, t.orderId)]);

export const loyaltyAccounts = pgTable("loyalty_accounts", {
  id: id(), customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }).unique(),
  restaurantId: rid(), points: integer("points").notNull().default(0), lifetimePoints: integer("lifetime_points").notNull().default(0), tier: text("tier").notNull().default("BRONZE"),
});
export const loyaltyTransactions = pgTable("loyalty_transactions", {
  id: id(), accountId: uuid("account_id").notNull().references(() => loyaltyAccounts.id, { onDelete: "cascade" }),
  points: integer("points").notNull(), kind: text("kind").notNull(),
  refKey: text("ref_key"), note: text("note"), createdAt: createdAt(),
}, (t) => [uniqueIndex("lt_ref_uq").on(t.accountId, t.refKey)]);

export const reviews = pgTable("reviews", {
  id: id(), restaurantId: rid(), orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }).unique(),
  customerId: uuid("customer_id"), food: integer("food").notNull(), service: integer("service").notNull(), ambience: integer("ambience").notNull(),
  cleanliness: integer("cleanliness"), overall: integer("overall").notNull(), comment: text("comment"), photoUrl: text("photo_url"), createdAt: createdAt(),
});

export const notifications = pgTable("notifications", {
  id: id(), restaurantId: rid(), role: text("role"), userId: uuid("user_id"), customerSessionId: uuid("customer_session_id"),
  title: text("title").notNull(), body: text("body"), kind: text("kind").notNull().default("info"), read: boolean("read").notNull().default(false), createdAt: createdAt(),
}, (t) => [index("notif_rest_idx").on(t.restaurantId, t.createdAt)]);

export const gameSessions = pgTable("game_sessions", {
  id: id(), restaurantId: rid(), game: text("game").notNull(), tableId: uuid("table_id").references(() => cafeTables.id, { onDelete: "set null" }),
  state: jsonb("state").notNull().default({}), status: text("status").notNull().default("OPEN"), createdAt: createdAt(),
});
export const gameScores = pgTable("game_scores", {
  id: id(), restaurantId: rid(), gameSessionId: uuid("game_session_id").references(() => gameSessions.id, { onDelete: "set null" }),
  customerSessionId: uuid("customer_session_id").notNull().references(() => customerSessions.id, { onDelete: "cascade" }), tableId: uuid("table_id").references(() => cafeTables.id, { onDelete: "set null" }),
  game: text("game").notNull(), score: integer("score").notNull(), rewardPoints: integer("reward_points").notNull().default(0), createdAt: createdAt(),
});

export const reservations = pgTable("reservations", {
  id: id(), restaurantId: rid(), tableId: uuid("table_id").references(() => cafeTables.id, { onDelete: "set null" }),
  name: text("name").notNull(), phone: text("phone").notNull(), email: text("email"), partySize: integer("party_size").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(), durationMin: integer("duration_min").notNull().default(90),
  status: text("status").notNull().default("CONFIRMED"), createdAt: createdAt(),
});
export const waitlist = pgTable("waitlist", {
  id: id(), restaurantId: rid(), name: text("name").notNull(), phone: text("phone"), partySize: integer("party_size").notNull(),
  status: text("status").notNull().default("WAITING"), notifiedAt: timestamp("notified_at", { withTimezone: true }), createdAt: createdAt(),
});

export const shifts = pgTable("shifts", {
  id: id(), restaurantId: rid(), userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(), endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }), checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
});

export const auditLogs = pgTable("audit_logs", {
  id: id(), restaurantId: uuid("restaurant_id"), userId: uuid("user_id"), action: text("action").notNull(), entity: text("entity"), entityId: text("entity_id"),
  meta: jsonb("meta").default({}), createdAt: createdAt(),
}, (t) => [index("audit_rest_idx").on(t.restaurantId, t.createdAt)]);
