# Shop App

A small but realistic web shop backend + static frontend used for testing and e2e scenarios.

## Quick Start

```bash
npm start        # Start server on port 4310
npm run dev      # Start with file watching
npm test         # Run tests
```

Server logs: `Shop listening on http://localhost:4310`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/products` | List all products |
| GET | `/api/products/:id` | Get product by ID |
| GET | `/api/cart` | Get current user's cart (requires `x-user` header) |
| POST | `/api/cart/items` | Add item to cart (`{ productId, quantity? }`) |
| DELETE | `/api/cart/items/:productId` | Remove item from cart |
| POST | `/api/orders` | Checkout (validates cart, stock, charges payment) |
| GET | `/api/orders/:id` | Get order by ID |
| POST | `/api/orders/:id/cancel` | Cancel order (paid + < 24h only) |
| GET | `/api/me` | Get current user (requires `x-user` header) |

## Example Usage

```bash
# List products
curl localhost:4310/api/products

# Add to cart (as user u1)
curl -X POST localhost:4310/api/cart/items \
  -H "x-user: u1" -H "Content-Type: application/json" \
  -d '{"productId": "p1", "quantity": 1}'

# Checkout
curl -X POST localhost:4310/api/orders -H "x-user: u1"

# View order
curl -H "x-user: u1" localhost:4310/api/orders/ord_...

# Cancel order (if paid and < 24h)
curl -X POST -H "x-user: u1" localhost:4310/api/orders/ord_.../cancel
```

## Frontend

Open `http://localhost:4310` in a browser for the vanilla JS SPA.

## Project Structure

```
src/
  server.ts              # Express entry point
  api/index.ts           # Router mounting
  auth/middleware.ts     # x-user header auth
  db/memory.ts           # In-memory store + repos
  catalog/               # Products API
  cart/                  # Cart API
  orders/                # Orders API + pricing
  payments/stripe.ts     # Stripe or fake charge
  users/                 # User API
  notifications/email.ts # Order confirmation (console)
public/
  index.html             # SPA shell
  app.js                 # Frontend logic
prisma/schema.prisma     # Target schema (docs only)
test/                    # node:test tests
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4310` | Server port |
| `STRIPE_SECRET_KEY` | unset | Enables real Stripe charges |
| `SMTP_URL` | unset | Logged in confirmation emails |

## Testing

```bash
npm test
# Runs test/*.test.ts with node:test
```

## License

MIT