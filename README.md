# E-commerce Backend

[![CI](https://github.com/mohatab/ecommerce-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/mohatab/ecommerce-backend/actions/workflows/ci.yml)

A production-grade e-commerce backend, built as a portfolio project to demonstrate clean, maintainable backend architecture.

## Tech Stack

- **Node.js** / **TypeScript** (strict mode)
- **NestJS** — application framework
- **PostgreSQL** + **Prisma ORM** — persistence
- **Redis** + **BullMQ** — caching and background jobs *(added in a later phase)*
- **JWT** (`@nestjs/jwt`) — authentication, HS256 access tokens
- **Argon2id** (`@node-rs/argon2`) — password hashing
- **`@nestjs/throttler`** — rate limiting
- **Docker** — containerization
- **Jest** — testing
- **Swagger** — API documentation

## Project Status

This project is being built incrementally, phase by phase. Current phase: **payments (Phase 4)**.

- ✅ Project structure, config validation, Prisma wiring, health check, Swagger, Docker (Postgres)
- ✅ Foundation: `/api/v1` versioning, pagination primitives, Prisma error mapping, e2e harness, CI
- ✅ Authentication: register, login, refresh with rotation and reuse detection, logout, global fail-closed JWT guard, rate limiting
- ✅ Products: public catalog reads, admin-only writes, role-based authorization, admin bootstrap
- ✅ Cart & orders: transactional checkout, atomic stock decrement, idempotent order creation, cancellation with exactly-once stock restore
- ⬜ Payments
- ⬜ Redis caching & BullMQ background jobs

## Getting Started

### Prerequisites

- Node.js 20+
- Docker

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment variables
cp .env.example .env

# 3. Start PostgreSQL (dev on 5432, test on 5433)
docker compose up -d

# 4. Generate the Prisma client
npm run prisma:generate

# 5. Run the app in watch mode
npm run start:dev
```

The API will be available at `http://localhost:3000`, with Swagger docs at `http://localhost:3000/api/docs`.

> **`JWT_SECRET` must be at least 32 characters.** Boot aborts with a Joi validation error naming the variable if it is missing or too short — that is the fail-fast behaviour working, not a bug. `.env.example` ships a placeholder; replace it with a real random value.

### Running the tests

```bash
# Unit tests
npm test

# End-to-end tests — requires the dedicated test database on port 5433
docker compose up -d postgres-test
npm run test:e2e
```

E2E tests run against a real Postgres instance (not a mock), addressed by
`TEST_DATABASE_URL`. Migrations are applied once per run, and the suite runs
serially by design.

> The suite runs serially on purpose — see
> [`docs/deferred-limitations.md`](docs/deferred-limitations.md), which also
> records the accepted rate-limiting, token-purge and deployment gaps.

## API

All domain routes live under `/api/v1`. `/health` is deliberately unprefixed and
unversioned so infrastructure probes have a stable path.

| Route | Auth | Success | Notes |
| --- | --- | --- | --- |
| `GET /health` | public | 200 | Liveness + database check |
| `POST /api/v1/auth/register` | public | 201 | Returns tokens; duplicate email → 409 |
| `POST /api/v1/auth/login` | public | 200 | Invalid credentials → 401 |
| `POST /api/v1/auth/refresh` | public | 200 | Rotates the token; reuse revokes the family |
| `POST /api/v1/auth/logout` | **Bearer** | 204 | Revokes every refresh token for the caller |
| `GET /api/v1/auth/me` | **Bearer** | 200 | The authenticated principal |
| `GET /api/v1/products` | public | 200 | Active products only; paginated |
| `GET /api/v1/products/:id` | public | 200 | Deactivated product → 404 |
| `GET /api/v1/categories` | public | 200 | |
| `POST /api/v1/admin/products` | **Bearer (ADMIN)** | 201 | Unknown `categoryId` → 409 |
| `PATCH /api/v1/admin/products/:id` | **Bearer (ADMIN)** | 200 | Unknown id → 404; unknown `categoryId` → 409; `{ "isActive": true }` restores |
| `DELETE /api/v1/admin/products/:id` | **Bearer (ADMIN)** | 204 | Soft deactivation, not a delete; unknown id → 404 |
| `POST /api/v1/admin/products/:id/stock-adjustments` | **Bearer (ADMIN)** | 200 | `{ delta }`, a signed relative change; below zero → 409; unknown id → 404 |
| `GET /api/v1/cart` | **Bearer** | 200 | The caller's cart; does not create one — an absent cart reads as empty |
| `PUT /api/v1/cart/items/:productId` | **Bearer** | 200 | `{ quantity }`, integer 1–99; **sets** the quantity, never increments; unknown/inactive product → 404; 51st line → 422 |
| `DELETE /api/v1/cart/items/:productId` | **Bearer** | 204 | Idempotent; removing an absent line also returns 204 |
| `POST /api/v1/orders` | **Bearer** | 201 / 200 | Checkout; requires an `Idempotency-Key` header (see below); 201 for a new order, 200 for a replayed key; empty cart, insufficient stock, or an unavailable product → 409; mixed currencies or an oversized total → 422 |
| `GET /api/v1/orders` | **Bearer** | 200 | The caller's orders only, paginated, newest first |
| `GET /api/v1/orders/:id` | **Bearer** | 200 | The caller's order only; unknown id or another user's order → 404 |
| `POST /api/v1/orders/:id/cancel` | **Bearer** | 200 | Idempotent; restores stock exactly once; unknown id or another user's order → 404 |

Authentication is **default-deny**: a route without an explicit `@Public()` marker
is protected by a global JWT guard. Register, login, and refresh are rate-limited to
5 requests/minute; everything else to 100/minute. The three public catalog reads
need no token; the admin product routes require a Bearer token for a user with the
`ADMIN` role.

### Checkout idempotency

`POST /api/v1/orders` requires an `Idempotency-Key` header: 8–128 characters of
`A-Z`, `a-z`, `0-9`, `_` or `-`. A missing or malformed key is a 400. The header
consumes the caller's cart — there is no request body. Replaying the same key
for the same caller returns the original order with **200** instead of creating
a second one; a different caller reusing the same key value gets their own new
order, because the key is scoped to `(userId, idempotencyKey)`. Stock is
decremented with an atomic, conditional update inside one transaction, so
concurrent checkouts for the last unit of a product cannot oversell it.

Phase 2 ships no category write route, so a category must exist before
`POST /api/v1/admin/products` can succeed — until one arrives, insert the
category directly in the database. A deactivated product (`DELETE`) is
recoverable only by an operator who already holds its id: there is no admin
list route to rediscover it once lost.

### Creating the first administrator

Registration always creates a `CUSTOMER`. The first `ADMIN` comes from the
bootstrap command, which is idempotent and never overwrites an existing
user's password:

```bash
# Set ADMIN_EMAIL and ADMIN_PASSWORD in .env first
npm run build
node dist/scripts/bootstrap-admin.js
```

If the address is unknown, it creates an administrator. If it already exists,
it promotes that account and leaves the password untouched. Running it twice
is safe. Change the password after first login and remove `ADMIN_PASSWORD`
from the environment.

### Useful Scripts

| Script                  | Description                          |
| ------------------------ | ------------------------------------ |
| `npm run start:dev`      | Run the app in watch mode            |
| `npm run build`          | Compile the app                      |
| `npm run lint`           | Lint and auto-fix                    |
| `npm run lint:ci`        | Lint without auto-fixing (used by CI)|
| `npm test`               | Run unit tests                       |
| `npm run test:e2e`       | Run end-to-end tests                 |
| `npm run prisma:generate`| Regenerate the Prisma client         |
| `npm run prisma:migrate` | Create/apply a local dev migration   |

## Project Structure

```
src/
  main.ts            # application bootstrap (Swagger, listen)
  bootstrap.ts        # configureApp() — shared runtime/test configuration
  app.module.ts       # composition root
  config/             # environment validation + typed configuration
  common/             # cross-cutting concerns (filters, interceptors, etc.)
  prisma/             # PrismaService, injectable database client
  modules/
    health/           # liveness + database check
    auth/             # hashing, tokens, refresh rotation, guards, DTOs
    users/            # User persistence (service-only, no controller)
    products/         # public catalog, admin writes, stock CAS methods
    cart/             # per-user cart, locked for checkout
    orders/           # order reads, checkout transaction, cancellation
prisma/
  schema.prisma        # Prisma schema (datasource + generator)
  migrations/          # committed migrations, applied via prisma migrate deploy
test/                  # e2e tests
  helpers/             # createTestApp, truncateAll
  fixtures/            # controllers used only by tests
  factories/           # test data builders (insert via the Prisma client)
```

`UsersModule` owns the `User` model and exports `UsersService` with no controller;
`AuthModule` owns refresh tokens, hashing, and the guard, and depends on it. The
split keeps later phases from dragging the JWT stack in just to resolve a user.
