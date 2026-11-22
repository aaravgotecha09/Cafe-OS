# CAFE-OS Backend (Express + Drizzle ORM + PostgreSQL + Socket.IO)

```bash
cp .env.example .env            # defaults work for local development
npm install
npm run db:migrate              # applies ./drizzle migrations to DATABASE_URL
npm run db:seed                 # demo café (dev only; set SEED_RESET=true to wipe first)
npm run dev                     # http://localhost:4000  (Swagger UI at /api/docs)
npm run typecheck && npm run lint && npm test && npm run build
npm run smoke                   # live smoke test against a running API + frontend
```

Layout: `src/db` (schema, migrate, seed) · `src/routes` (HTTP) · `src/services` (business logic: pricing, orders/kitchen, billing, gateway, loyalty, inventory, receipts) · `src/sockets` · `src/middleware` · `tests` (vitest + supertest + socket.io-client against a real PostgreSQL).

Changing the schema: edit `src/db/schema.ts` → `npx drizzle-kit generate` → commit the new file in `drizzle/` → `npm run db:migrate`.
Tests create and drop their own database (`cafeos_test`) from `TEST_DATABASE_URL` (default `postgresql://cafe:cafe@localhost:5432/cafeos_test`), so the role needs `CREATEDB`.
