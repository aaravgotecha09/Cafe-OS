# API Documentation

Interactive Swagger UI: `GET /api/docs` · machine-readable: `GET /api/openapi.json` (generated from `backend/src/openapi.ts`; request/response shapes below are authoritative where they differ in detail).

## Conventions
- Base path `/api`. JSON in/out. **Money is integer paise.**
- Success: `{ "success": true, "data": …, "meta"?: { page, limit, total } }`
- Error: `{ "success": false, "error": { "code", "message", "details"? } }` with codes `BAD_REQUEST 400 · UNAUTHORIZED 401 · FORBIDDEN 403 · NOT_FOUND 404 · CONFLICT 409 · DUPLICATE 409 · COOLDOWN/RATE_LIMIT 429 · INTERNAL 500`. Validation errors carry Zod `details`.
- Pagination `?page=&limit=` (max 100). CSV: add `?format=csv` on analytics/customers/payments endpoints.
- Auth:
  - **Staff**: `Authorization: Bearer <accessToken>` (15 min). `POST /auth/refresh` rotates the refresh token (reuse of an old one revokes the whole family).
  - **Customer**: `x-session-token` returned by `POST /qr/resolve`. Valid while the table session is open and read-only for 24 h after payment (receipt, review).
- Rate limits: 600 req/min/IP on `/api`; 30 attempts/15 min on auth endpoints.

## Endpoint groups (see Swagger for the full list)
| Group | Highlights | Auth |
|---|---|---|
| `/auth` | login, refresh, logout, me, forgot/reset password, register-restaurant | public / staff |
| `/menu`, `/restaurant/:slug` | menu with variants/customizations, search & diet filters | public |
| `/qr/resolve` | validates signed QR → opens/joins table session | public |
| `/session`, `/customer/identify`, `/history`, `/favourites/:id` | session + optional profile | customer |
| `/cart/price`, `/coupons/validate`, `/orders` | server-side pricing; order creation (transactional) | customer |
| `/requests`, `/wifi` | service requests (dedupe + 60 s cooldown), Wi-Fi from settings | customer |
| `/billing`, `/billing/split`, `/payments…`, `/receipts/:id.pdf` | bill, equal/items/custom split, idempotent payments, PDF | customer |
| `/loyalty`, `/offers`, `/reviews`, `/games/*`, `/reservations`, `/waitlist` | rewards, games, bookings | customer / public |
| `/staff/*` | overview, floor, orders + transitions, requests, cash payments, notifications | staff roles |
| `/kitchen/*` | queue, ticket actions, item ready, history | kitchen roles |
| `/admin/*` | menu/categories/stations/tables/QR/staff/shifts/inventory/coupons/customers/reviews/reservations/payments/refunds/settings/audit/analytics | manager+ (settings write: owner) |
| `/payments/webhook` | Razorpay webhook (raw body, HMAC verified) | signature |
| `/dev/table-links` | demo QR links — **not mounted in production** | none |

## Order lifecycle
`PLACED → CONFIRMED → SENT_TO_KITCHEN → PREPARING → READY → SERVED → COMPLETED` (+ `REJECTED` requires a reason, `CANCELLED`: waiter only while `PLACED`, manager later, never if paid). Tickets are created per station at order time but only reach the kitchen when the waiter sends the order; the order becomes `READY` only when **all** station tickets are ready. Inventory is deducted (once) when sent to the kitchen. `COMPLETED` happens automatically when an order is both served and paid.

## Payments
`POST /payments {splitId?, method, tipPercent|tipAmount, idempotencyKey}` → creates a PENDING payment (reuses an identical pending one). Completion happens only via server-verified paths: `POST /payments/:id/verify` (HMAC + provider fetch), the signed webhook, or staff cash entry. The bill row is locked in a transaction so `paidAmount ≤ total` always holds. In test mode `POST /payments/:id/test-checkout` stands in for the Razorpay popup and returns a server-signed id that `/verify` checks the same way.

## Realtime (Socket.IO, same origin as the API)
Connect with `auth: { token }` (staff) or `auth: { sessionToken }` (customer). Staff auto-join restaurant + role rooms; customers join their own table room (not once the session is closed); `join:order` only succeeds for orders of the caller's table session.
Events: `customer:order_created`, `staff:order_received`, `kitchen:order_received`, `order:status_updated`, `order:item_updated`, `kitchen:item_ready`, `waiter:service_requested`, `waiter:request_accepted`, `waiter:request_completed`, `table:status_updated`, `payment:completed`, `payment:failed`, `notification:new`, `game:challenge_created`, `game:state`, `game:score_updated`.
Events are hints: every important state is persisted first, and clients re-fetch from the API on reconnect.
