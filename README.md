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

This project is being built incrementally, phase by phase. Current phase: **authentication (Phase 1)**.

- ✅ Project structure, config validation, Prisma wiring, health check, Swagger, Docker (Postgres)
- ✅ Foundation: `/api/v1` versioning, pagination primitives, Prisma error mapping, e2e harness, CI
- ✅ Authentication: register, login, refresh with rotation and reuse detection, logout, global fail-closed JWT guard, rate limiting
- ⬜ Products
- ⬜ Orders
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

Authentication is **default-deny**: a route without an explicit `@Public()` marker
is protected by a global JWT guard. Register, login, and refresh are rate-limited to
5 requests/minute; everything else to 100/minute.

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
