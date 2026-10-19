# ADR 0001: In-Memory Store for Shop App

## Status
Accepted

## Context
The Shop App is a sample project used for testing and e2e scenarios. It needs a data store that:
- Requires zero external dependencies (no database server)
- Is fast and deterministic for tests
- Can be easily reset between test runs
- Simulates realistic CRUD operations

## Decision
Use an in-memory store (`src/db/memory.ts`) with:
- `Map`-based tables for Users, Products, Carts, Orders, Payments
- Seeded with ~6 products and 2 users on initialization
- `resetDB()` function to restore initial state
- Repository pattern for data access (no Express imports in services)

Persistence schema is documented in `prisma/schema.prisma` but Prisma is NOT installed or used at runtime.

## Consequences
- ✅ Zero infrastructure requirements
- ✅ Fast test execution
- ✅ Deterministic state for testing
- ✅ Easy to understand and modify
- ❌ Data not persisted across restarts
- ❌ Not suitable for production use
- ❌ No concurrent access protection (single-threaded Node is fine for this use case)