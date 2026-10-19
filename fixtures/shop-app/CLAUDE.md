# Shop App — Project Overview

A small but realistic web shop backend + static frontend used for testing and e2e scenarios.

## Commands

```bash
npm run dev      # Start with file watching (Node --watch)
npm start        # Start production server
npm test         # Run tests with node:test
```

Server listens on `process.env.PORT ?? 4310`.

## Conventions

- **TypeScript with Node 24 type stripping**: imports use `.ts` extensions, no enums/namespaces/parameter properties
- **ESM everywhere**: `"type": "module"` in package.json
- **Plain Node APIs**: `node:test`, `node:assert`, `node:fs/promises`, etc.
- **In-memory store**: `src/db/memory.ts` seeded with ~6 products and 2 users
- **Services are framework-agnostic**: no Express imports in services, only in routes
- **Fake payments**: Stripe SDK used only when `STRIPE_SECRET_KEY` is set, otherwise deterministic fake charge
- **Auth**: simple header-based (`x-user`) via `src/auth/middleware.ts`

## Architecture

```
src/
  server.ts           # Express entry point
  api/index.ts        # Mounts all routers under /api
  auth/middleware.ts  # x-user header auth
  db/memory.ts        # In-memory DB + repositories
  catalog/            # Products (GET /products, GET /products/:id)
  cart/               # Cart (GET /cart, POST /cart/items, DELETE /cart/items/:id)
  orders/             # Orders (POST /orders, GET /orders/:id, POST /orders/:id/cancel)
  payments/stripe.ts  # Stripe or fake charge
  users/              # GET /me
  notifications/email.ts # Order confirmation (console log)
  pricing.ts          # Tax calculation (19%)
public/
  index.html          # SPA with hash routing
  app.js              # Vanilla JS frontend
prisma/schema.prisma  # Target persistence schema (documentation only)
test/                 # node:test tests against services
```

## Business Rules

- Checkout validates: cart not empty, stock available
- Tax: 19% (see `src/orders/pricing.ts`)
- Payment: charges via Stripe or fake provider
- Successful payment → decrements stock, clears cart, sends confirmation email
- Failed payment → restores stock, marks order cancelled
- Cancel order: only if status `paid` and < 24 hours old

## Frontend

Vanilla JS SPA with hash routing:
- `/` — product list
- `/product/:id` — product detail + add to cart
- `/cart` — cart view + checkout
- `/order/:id` — order confirmation + cancel button