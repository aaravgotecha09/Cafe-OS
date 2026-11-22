# Database Guide (PostgreSQL 16 + Drizzle ORM)

Schema source of truth: `backend/src/db/schema.ts`. Migrations (SQL): `backend/drizzle/`.

## Workflow
```bash
npm run db:migrate                  # apply migrations (dev: tsx; prod: npm run db:migrate:prod)
npx drizzle-kit generate            # after editing schema.ts → writes a new SQL migration (commit it)
npm run db:seed                     # demo data (dev) · SEED_RESET=true wipes first (never in production)
```
Test DB is created/dropped automatically by the test suite.

## Design rules
- **Money = integer paise** everywhere (`price`, `total`, `amount`, …). Percent/tax rates are `numeric`.
- **Multi-tenant**: every business table carries `restaurant_id` (FK, `ON DELETE CASCADE`); all queries are scoped by the tenant id from the JWT / customer session. `restaurants.slug` selects the public tenant.
- UUID primary keys (`gen_random_uuid()`), `timestamptz` timestamps.
- Integrity is enforced by the database where races matter: `payments (bill_id, idempotency_key)` unique, `loyalty_transactions (account_id, ref_key)` unique (rewards are idempotent), `reviews.order_id` unique, `coupon_redemptions (coupon_id, order_id)` unique, `bills.table_session_id` unique, `orders (restaurant_id, order_number)` unique, `kitchen_tickets (order_id, station_id)` unique.
- Transactions with row locks (`SELECT … FOR UPDATE`) guard: order status changes, bill/payment finalization, split creation, inventory deduction/adjustment, game moves. Advisory locks serialize table-session creation per table and reservation booking per restaurant.

## Tables (39)
Tenancy/people: `restaurants`, `branches`, `users` (role enum), `refresh_tokens`, `password_resets`, `customers`, `shifts`
Floor: `cafe_tables` (QR nonce, layout x/y), `table_sessions`, `customer_sessions`, `service_requests`, `reservations`, `waitlist`
Menu: `categories`, `products` (allergens/ingredients/tags arrays), `product_variants`, `customization_groups`, `customization_options`, `kitchen_stations`
Inventory: `inventory_items`, `recipe_ingredients`, `stock_movements`
Orders: `orders`, `order_items` (customizations JSON snapshot), `order_status_history`, `kitchen_tickets`
Money: `bills`, `bill_splits`, `payments`, `refunds`, `coupons`, `coupon_redemptions`
Engagement: `loyalty_accounts`, `loyalty_transactions`, `reviews`, `game_sessions`, `game_scores`, `notifications`
Ops: `audit_logs`
Enums: `role`, `table_status`, `order_status`, `ticket_status`, `request_type`, `request_status`, `payment_status`, `payment_method`, `coupon_type`.

## QR tokens
`base64url({r: restaurantId, t: tableId, n: nonce}) + "." + HMAC-SHA256(QR_SIGNING_SECRET)`. Valid only if the signature matches **and** `n` equals `cafe_tables.qr_nonce`; "Regenerate QR" changes the nonce, revoking the old code instantly.

## Backups & retention
Enable provider backups. `audit_logs`, `stock_movements`, `order_status_history` are append-only history; archive them yourself if they grow large. Customer PII (name/phone/email/birthday) lives only in `customers`.
