# E-commerce Backend

[![CI](https://github.com/mohatab/ecommerce-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/mohatab/ecommerce-backend/actions/workflows/ci.yml)

A production-grade e-commerce backend, built as a portfolio project to demonstrate clean, maintainable backend architecture.

## Tech Stack

- **Node.js** / **TypeScript** (strict mode)
- **NestJS** — application framework
- **PostgreSQL** + **Prisma ORM** — persistence
- **`@nestjs/schedule`** — in-process cron for scheduled maintenance
- **JWT** (`@nestjs/jwt`) — authentication, HS256 access tokens
- **Argon2id** (`@node-rs/argon2`) — password hashing
- **`@nestjs/throttler`** — rate limiting
- **`stripe`** — payment provider SDK, pinned API version
- **Docker** — containerization
- **Jest** — testing
- **Swagger** — API documentation

## Project Status

This project is being built incrementally, phase by phase. Current phase: **Deployment (Phase 6)**.

- ✅ Project structure, config validation, Prisma wiring, health check, Swagger, Docker (Postgres)
- ✅ Foundation: `/api/v1` versioning, pagination primitives, Prisma error mapping, e2e harness, CI
- ✅ Authentication: register, login, refresh with rotation and reuse detection, logout, global fail-closed JWT guard, rate limiting
- ✅ Products: public catalog reads, admin-only writes, role-based authorization, admin bootstrap
- ✅ Cart & orders: transactional checkout, atomic stock decrement, idempotent order creation, cancellation with exactly-once stock restore
- ✅ Payments: provider-abstracted intent creation, idempotent initiation, signature-verified webhook as the only path to `PAID`
- ✅ Scheduled maintenance: order expiry releasing stock exactly once, retention purges for `refresh_tokens` and `payment_events`, payment reconciliation (detection only), an admin trigger and findings API — all under a fenced database lease, with no new infrastructure
- ⬜ Deployment: container smoke test, trusted-proxy configuration, release/migration process

**Redis and BullMQ are not on this list, and that is a decision rather than a gap.**
A delayed job is a single point of loss — if the broker drops it, nothing re-derives
the work. Every Phase 5 job is a *sweep* that re-reads the world each tick and is
therefore self-healing, so a broker would add an operational dependency and a new
failure mode while removing nothing. A broker earns its place when a workload is
genuinely event-driven and non-idempotent; **transactional email** and **refunds**
are the two candidates, and neither exists yet.

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
> records the accepted rate-limiting and deployment gaps.

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
| `GET /api/v1/orders/:id` | **Bearer** | 200 | The caller's order only; unknown id or another user's order → 404. Carries the server-authoritative `expiresAt` deadline |
| `POST /api/v1/orders/:id/cancel` | **Bearer** | 200 | Idempotent; restores stock exactly once; unknown id or another user's order → 404 |
| `POST /api/v1/orders/:id/payments` | **Bearer** | 201 / 200 | Creates a payment intent for the caller's own `PENDING` order, or returns the existing one — empty request body by design. 201 the first time, 200 on every replay with the same payment id, provider id and client secret; malformed id → 400; no token → 401; unknown id or another user's order → 404; the order is cancelled or already paid → 409; total outside the payable range or an unsupported currency → 422; provider unreachable → 502. **It does not complete the payment** |
| `POST /api/v1/admin/maintenance/:job/run` | **Bearer (ADMIN)** | 200 | Runs one maintenance job synchronously, through the same runner the schedule uses. `:job` is `order-expiry`, `maintenance-purge`, or `payment-reconciliation`; anything else → 400. Already running (the lease is held) → 409. Rate-limited to 5/minute. The response is a counts-only summary — no order, payment, or customer identifier |
| `GET /api/v1/admin/reconciliation/findings` | **Bearer (ADMIN)** | 200 | Paginated findings, **active ones (`resolvedAt IS NULL`) by default**; `?resolved=true` for the historical ones, `?kind=` to filter. An unlisted kind or a non-boolean `resolved` → 400 |
| `POST /api/v1/payments/webhook` | public (**signature**) | 200 | The provider's signed delivery, verified over the raw request body. The only path that marks an order `PAID`. Invalid or missing signature, or an unusable payload → 400; too many deliveries → 429; a database failure mid-transaction → 500 so the provider retries. Every other authentic delivery — unknown order, amount or currency mismatch, duplicate, already-paid, cancelled order — is **200** with the event recorded and nothing else changed |

Authentication is **default-deny**: a route without an explicit `@Public()` marker
is protected by a global JWT guard. Register, login, and refresh are rate-limited to
5 requests/minute, the payment webhook to 300/minute (one provider's small IP set
sends every delivery, and the global limit would throttle a legitimate burst);
everything else to 100/minute. The three public catalog reads
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

### Payments

Three environment variables, validated by Joi at boot like every other:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PAYMENT_PROVIDER` | always, no default | `stripe` or `fake`. Selects the adapter. **`fake` is rejected under `NODE_ENV=production`** — boot aborts |
| `PAYMENT_API_KEY` | only when `PAYMENT_PROVIDER=stripe` | The provider credential. Use a test-mode key. Leave it unset (not empty) while the provider is `fake` |
| `PAYMENT_WEBHOOK_SECRET` | always | The webhook HMAC secret, used by whichever adapter is selected. Minimum 16 characters; boot aborts if it is missing or empty |

`fake` is a real, config-selected implementation — not a test double — and it
signs and verifies in constant time exactly like the real path, so local
development and the e2e suite exercise the same pipeline. It is simply never
selectable in production.

**Completing a payment.** This API creates a payment intent and returns its
client secret; it never completes the payment. Boot with
`PAYMENT_PROVIDER=stripe` and test-mode credentials, `POST /api/v1/orders`,
then `POST /api/v1/orders/:id/payments`. Complete the returned intent with
Stripe's own test tooling (CLI or test-mode dashboard). Stripe then delivers
a signed `payment_intent.succeeded` to `POST /api/v1/payments/webhook`, and
**only that verified webhook** marks the order `PAID`. `GET /api/v1/orders/:id`
will then show `PAID`. There is deliberately no confirm endpoint.

Repeating `POST /api/v1/orders/:id/payments` never creates a second intent: the
persisted `payments` row, not the provider's idempotency key, is what makes that
true, so it still holds after the provider's key-retention window has passed.

**Not every `PENDING` order can be paid.** A total outside the payable range —
below 50 or above 99,999,999 minor units — or a currency other than `USD`
returns **422**, before any provider call. The maximum is the lowest documented
provider tier, because the payment method is not known at initiation. Such an
order stays valid and cancellable; see
[`docs/deferred-limitations.md`](docs/deferred-limitations.md), which also
records that a payment arriving after its order was cancelled is recorded but
**not** refunded, and that nothing reconciles provider state against local state
automatically.

### Scheduled maintenance

Three cron jobs run in-process (`@nestjs/schedule`), each a **sweep**: it re-reads
the world every tick, so a missed tick costs latency and never correctness.

| Job | Default schedule | What it does |
| --- | --- | --- |
| `order-expiry` | every 5 minutes | Expires `PENDING` orders past their deadline and restores every line's stock, atomically. Tier A (no payment attempt) after 30 minutes; tier B (a payment was initiated) after 24 hours **and** only once the provider confirms the payment did not succeed |
| `maintenance-purge` | daily at 03:00 | Deletes `refresh_tokens` past their expiry retention and `payment_events` past theirs, oldest first, bounded per tick |
| `payment-reconciliation` | every 15 minutes | Compares local payment and order state against the provider and records divergences. **It reports; it never mutates an order, a payment, or a product** |

Only one instance may run a given job at a time. Exclusion is a `maintenance_leases`
row claimed with a compare-and-swap and **re-asserted inside the same transaction as
every mutation**, so an instance whose lease was taken over cannot commit. PostgreSQL
advisory locks were deliberately rejected: Prisma pools connections with no pinning
API, so a session-scoped lock can be released on the wrong connection and leak, and an
xact-scoped one cannot span a sweep that makes provider calls outside transactions and
commits one transaction per order.

**The expiry sweep never marks an order paid.** It asks the provider only for
permission *not* to expire — a veto, never an authority — and if the provider is
unreachable, times out, or does not recognise the payment, the order is left
`PENDING`. The signature-verified webhook remains the only path to `PAID`.

An order that expires moves to `EXPIRED`, its stock returns, and cancelling it
afterwards is a **409** — the stock is already back and cancelling again would hand
it out twice.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAINTENANCE_JOBS_ENABLED` | `true` | Master switch. Only the literal `false` disables every job |
| `ORDER_EXPIRY_CRON` | `0 */5 * * * *` | Six-field expression, seconds first |
| `ORDER_EXPIRY_TTL_MINUTES` | `30` | Tier-A deadline, stamped on the order at checkout |
| `ORDER_EXPIRY_PAYMENT_STARTED_TTL_HOURS` | `24` | Tier-B gate, measured from `Payment.createdAt` |
| `ORDER_EXPIRY_BATCH_SIZE` | `100` | Orders per tick |
| `MAINTENANCE_PURGE_CRON` | `0 0 3 * * *` | |
| `MAINTENANCE_PURGE_BATCH_SIZE` | `1000` | Rows per table per tick |
| `REFRESH_TOKEN_RETENTION_DAYS` | `30` | Floor 7. Cut on `expiresAt`, never `createdAt` — a live token is never deleted |
| `PAYMENT_EVENT_RETENTION_DAYS` | `90` | Floor 30. This table is the webhook idempotency ledger |
| `RECONCILE_CRON` | `0 */15 * * * *` | |
| `RECONCILE_MIN_AGE_MINUTES` | `15` | How settled a row must be before it is compared |
| `RECONCILE_LOOKBACK_DAYS` | `30` | |
| `RECONCILE_BATCH_SIZE` | `100` | |
| `RECONCILE_PRECHECK_FAILURE_THRESHOLD` | `3` | Consecutive failed reads before a `PROVIDER_UNREACHABLE` finding |
| `MAINTENANCE_LEASE_SECONDS` | `300` | Floor 30 — shorter than one heartbeat interval would lapse a live run |

`POST /api/v1/admin/maintenance/:job/run` runs any of the three immediately, through
the same runner the schedule uses, and returns **409** if that job is already running.
See [`docs/deferred-limitations.md`](docs/deferred-limitations.md) for what this
phase deliberately did **not** do — remediation, refunds, a findings purge, and
provider-side orphan discovery among them.

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
    orders/           # order reads, checkout transaction, cancellation, expiry, markPaid
    payments/         # intent initiation, provider adapters, signed webhook
    maintenance/      # lease, runner, scheduler, expiry sweep, purges, reconciliation, admin API
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
