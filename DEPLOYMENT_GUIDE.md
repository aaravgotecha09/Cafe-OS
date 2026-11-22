# Deployment Guide — Vercel (frontend) + Render (backend + PostgreSQL)

Deploy the **backend first** (the frontend needs its URL), then the frontend, then set `FRONTEND_URL` on the backend.

## 1. Backend on Render
Option A — Blueprint: push the repo, Render → *New → Blueprint*, point at `backend/render.yaml`. It creates the PostgreSQL database and a web service (`rootDir: backend`).
Option B — manual: *New Web Service*, root directory `backend`, build `npm ci --include=dev && npm run build`, start `npm run start:render`, health check `/health`, plus a PostgreSQL instance and its Internal URL as `DATABASE_URL`.

`start:render` runs `node dist/db/migrate.js` (applies pending Drizzle migrations from `backend/drizzle`) and then starts the server. Migrations are idempotent and tracked in `drizzle.__drizzle_migrations`.

Environment variables (all in `backend/.env.example`):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Render provides it. If your provider needs SSL, append `?sslmode=require`. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | long random strings (Blueprint generates them) |
| `QR_SIGNING_SECRET` | signs table QR tokens. **Changing it invalidates every printed QR code.** |
| `FRONTEND_URL` | exact Vercel origin(s), comma-separated, no trailing slash. Drives CORS + Socket.IO + QR link URLs. |
| `BACKEND_URL` | public API URL |
| `PAYMENT_TEST_MODE` | `true` until Razorpay is verified; the server **refuses live mode without keys** |
| `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET` | see §4 |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional; `EMAIL_FROM` must be a verified Resend sender/domain |
| `CLOUDINARY_*` | optional image uploads |
| `ALLOW_RESTAURANT_SIGNUP` | keep `false` in production |

Create the first real owner (no demo data in production):
```bash
# Render shell, or locally with DATABASE_URL pointing at the production DB
SEED_DEMO=true DEMO_PASSWORD='choose-a-strong-one' npm run db:seed:prod   # demo café, only for staging/demo
```
For a real café, instead call `POST /api/auth/register-restaurant` once (temporarily set `ALLOW_RESTAURANT_SIGNUP=true`), then set it back to `false`. Then create tables/menu in Admin and print QR codes.

WebSockets work on Render web services out of the box. Use a paid instance — free instances sleep and drop sockets (the app re-syncs from the API on reconnect, but staff would miss alerts).

## 2. Frontend on Vercel
Import the repo, **Root Directory = `frontend`**, framework Next.js (`vercel.json` included).
Environment variables (Production + Preview):
```
NEXT_PUBLIC_API_URL=https://<your-render-service>.onrender.com
NEXT_PUBLIC_RESTAURANT_SLUG=orange-oak        # slug shown in Admin → Settings / DB restaurants.slug
```
Deploy, then set the backend's `FRONTEND_URL` to the Vercel URL (and your custom domain) and redeploy/restart the backend. Socket.IO connects directly to `NEXT_PUBLIC_API_URL` (no Vercel proxying needed).

## 3. QR codes
Admin → *QR codes* generates codes from live table records (`<FRONTEND_URL>/table/<signed token>`). Print and place on tables. **Regenerate after changing `FRONTEND_URL`** (the URL is baked into the QR image; the signature itself is origin-independent). Use *Regenerate* on a table to revoke a leaked code.

## 4. Payments (Razorpay)
1. Razorpay Dashboard → API keys (start with **Test mode**) → set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
2. Webhooks → add `https://<api>/api/payments/webhook`, events `payment.captured`, `payment.failed`; set the same secret as `RAZORPAY_WEBHOOK_SECRET`.
3. Set `PAYMENT_TEST_MODE=false`. The customer app then opens Razorpay Checkout; the backend verifies the signature **and** re-fetches the payment from Razorpay before marking anything paid. The webhook is an independent second path (idempotent).
4. Walk through: single pay, split pay, failed payment, refund (Admin → Payments), with Razorpay test cards/UPI, before switching to live keys.
Apple Pay/Google Pay appear only if enabled on your Razorpay account.

## 5. Email
Add `RESEND_API_KEY` and a verified `EMAIL_FROM`. Used for PDF receipts (when the customer has an email) and password reset.

## 6. Operations
- Health: `GET /health` (checks DB). Logs: stdout. Graceful shutdown on SIGTERM.
- Backups: enable Render PostgreSQL backups. Money values are integer paise.
- Upgrades: push → Render builds → migrations run before the new version serves traffic.
- Rolling secrets: rotating `JWT_*` signs everyone out; rotating `QR_SIGNING_SECRET` invalidates printed QR codes.
