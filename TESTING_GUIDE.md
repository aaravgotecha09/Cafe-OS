# Testing Guide

```bash
# backend (needs PostgreSQL; role with CREATEDB)
cd backend && npm run typecheck && npm run lint && npm test
# frontend
cd frontend && npm run typecheck && npm run lint && npm test && npm run build
# live smoke (start backend and `next start` first)
cd backend && npm run smoke
```

## Backend — 33 tests, real PostgreSQL + real sockets (`backend/tests`)
- `auth.test.ts` — login/refresh rotation + reuse detection, RBAC matrix, role-escalation guard, multi-tenant isolation, password reset.
- `customer.test.ts` — signed/tampered/rotated QR, two diners sharing a table session, menu filters, server-side pricing (variants/options/required groups/foreign options), coupons (min order, first-order, BOGO), availability, service requests (dedupe, lifecycle, cooldown), Wi-Fi.
- `workflow.test.ts` — **the 18-step scenario**: scan Table 05 → cappuccino + sandwich with customizations → order persisted → waiter socket event → kitchen sees nothing until forwarded → per-station tickets → order only READY when all stations ready → served → bill → split in 2 → pay with tips via signature-verified test gateway (forged signature rejected, pending payment reused) → PDF receipt → loyalty awarded once → table CLEANING → review once. Plus socket auth/room scoping.
- `business.test.ts` — item/custom splits, **concurrent double-payment** (exactly one succeeds), idempotency, orders blocked after payment starts, cash by cashier, Razorpay-style webhook signature + replay, refunds (RBAC, over-refund, loyalty reversal), coupon/points release on reject/cancel, referral, inventory auto-disable/re-enable and negative-stock guard, quiz/spin/memory anti-cheat, server-authoritative tic-tac-toe, concurrent reservation booking, product CRUD, QR codes resolve, settings affect pricing, analytics reflect real orders, audit log.

## Frontend — 17 tests (Vitest + Testing Library, API mocked)
Price updates instantly on variant/option/quantity, required-option gating, cart merge/removal, menu search + diet filters + empty state, checkout (server totals, order POST, redirect, no-session state), tracker stages, waiter accept/reject-with-reason/serve, floor-map colour coding + selection, kitchen ticket overdue/allergens/actions, admin product-form validation and paise conversion.

## What is NOT covered
- Real-browser E2E (Playwright/Cypress): camera QR scan, Razorpay popup, drag-and-drop layout, layout at various breakpoints.
- Razorpay live/test-mode against Razorpay itself, Resend delivery, Cloudinary uploads.
- Load/soak testing and accessibility audits with assistive technology (keyboard, labels, contrast and reduced-motion were built in but not audited with a screen reader).
