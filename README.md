# CAFE-OS — Smart Café Operating System

QR table ordering → waiter floor map → kitchen display → admin dashboard → split-bill payments → receipts → loyalty. One backend, four interfaces.

| Part | Stack |
|---|---|
| `frontend/` | Next.js 16 (App Router), React 19, TypeScript, Tailwind, Framer Motion, TanStack Query, Zustand, Recharts, Socket.IO client |
| `backend/` | Node 22, Express, TypeScript, **Drizzle ORM + PostgreSQL 16**, Socket.IO, JWT + refresh rotation, Zod, Helmet, rate limiting, PDFKit, Razorpay, Resend |

## Quick start (local)

Prerequisites: Node 20+, PostgreSQL 14+ (a role with `CREATEDB`).

```bash
# 1. database
createdb cafeos     # e.g. role cafe/cafe — see backend/.env.example for the default DATABASE_URL

# 2. backend (terminal 1)
cd backend && cp .env.example .env && npm install
npm run db:migrate && npm run db:seed
npm run dev                          # http://localhost:4000, docs at /api/docs

# 3. frontend (terminal 2)
cd frontend && cp .env.example .env.local && npm install
npm run dev                          # http://localhost:3000
```

**Try it:** open `http://localhost:4000/api/dev/table-links` (development only) and open any `url` in a phone/browser → you're "sitting" at that table. Or print real codes from **Admin → QR codes**.

### Demo accounts (development seed only)
Password for all: `Demo@12345` (override with `DEMO_PASSWORD`).

| Role | Email | Sign in at |
|---|---|---|
| Owner | `owner@orangeoak.test` | `/admin/login` |
| Manager | `manager@orangeoak.test` | `/admin/login` |
| Waiter | `waiter1@orangeoak.test`, `waiter2@…` | `/staff/login` |
| Cashier | `cashier@orangeoak.test` | `/staff/login` |
| Kitchen | `kitchen@orangeoak.test` (hot), `barista@…` (coffee) | `/kitchen/login` |

The seed refuses to run when `NODE_ENV=production` unless `SEED_DEMO=true`, and then uses a random password printed once. Never ship the dev password.

Demo data: ORANGE & OAK CAFE (rename in Admin → Settings), 20 tables, 16 categories, 48 dishes (INR), kitchen stations, inventory + recipes, coupons, 3 customers with loyalty, reservations, and 70 historical paid orders so analytics have data.

## Verification status (what was actually run)

| Check | Result |
|---|---|
| Backend `tsc`, `eslint` (0 errors), production build, boot in `NODE_ENV=production` | ✅ |
| Drizzle migration on an empty PostgreSQL 16 database + seed | ✅ |
| Backend tests — 33, real PostgreSQL + real Socket.IO (auth, RBAC, QR, pricing, coupons, order state machine, kitchen routing, split bills, concurrent payments, webhook signatures, refunds, loyalty, inventory, games, reservations, admin CRUD, analytics) | ✅ 33/33 |
| Full 18-step workflow test (scan Table 05 → … → review) | ✅ |
| Frontend `tsc`, `eslint` (0 errors), `next build` (59 routes) | ✅ |
| Frontend tests — 17 (customization pricing, cart, menu search, checkout, tracker, waiter actions, floor map, kitchen tickets, admin form validation) | ✅ 17/17 |
| Live smoke (`backend/scripts/smoke.mjs`): CORS, all page routes, QR→order→Socket.IO→kitchen→TEST payment | ✅ |

## NOT verified / not implemented — read before going live

Honest list. Nothing here is hidden behind a fake success.

**Cannot be verified without your credentials**
- **Razorpay live payments**: code path exists (order create, signature check, server-side `payments.fetch` confirmation, webhook, refunds) but was never run against Razorpay. Until `RAZORPAY_*` are set and `PAYMENT_TEST_MODE=false`, the app uses a clearly labelled **TEST gateway** (no money moves; receipts are stamped "TEST MODE"). Run Razorpay's test-mode keys through the whole flow before going live.
- **Resend email** (receipts, password reset) and **Cloudinary uploads**: implemented, degrade gracefully when unset, not exercised against the real services.

**Not browser-tested**
- No real-browser end-to-end run was possible in the build sandbox. UI behaviour is covered by component tests plus the HTTP/Socket smoke test, not by Playwright/Cypress. Expect to find visual or interaction rough edges on real devices (especially the QR camera scanner, Razorpay checkout popup, drag-to-arrange floor map).

**Specified but not built (or only partly)**
- Customer **photo upload on reviews** (no customer upload endpoint; admin upload exists).
- **Multi-language** (English/Hindi/Marathi): not implemented — strings are inline English.
- **Browser (Web Push) notifications**: not implemented. In-app toasts, staff sound alerts, stored notifications, and email (when configured) are.
- **Multi-branch**: tables for branches exist and users/tables carry `branch_id`, but menus, inventory and reports are per-restaurant, not per-branch.
- **Waitlist** "notify": marks the guest notified and the guest page shows it on refresh; no SMS/push.
- **Currency setting** is stored but formatting is fixed to INR/₹; PDF receipts print "Rs." (built-in font has no ₹ glyph).
- Order **customizations are stored as a JSON snapshot** on each order item (not a separate `OrderItemCustomization` table), and allergens/roles/permissions are columns/enums rather than separate tables. Functionally equivalent here; differs from the long model list in the brief.

**Known design trade-offs**
- Customer "profile" is identified by **phone number without OTP** — anyone who knows a phone number can attach to its loyalty account. Add an OTP provider before relying on loyalty balances as money.
- Staff refresh tokens live in `localStorage` (cookie-less API ⇒ no CSRF surface, but XSS would expose them).
- Coupon usage limits are checked then recorded inside one transaction but without a row lock; two simultaneous last-use redemptions could both succeed.

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md), [API_DOCUMENTATION.md](API_DOCUMENTATION.md), [DATABASE_GUIDE.md](DATABASE_GUIDE.md), [TESTING_GUIDE.md](TESTING_GUIDE.md).
