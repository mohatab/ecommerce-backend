# Foundation Architecture — Design Spec

**Date:** 2026-08-12
**Status:** Approved for implementation
**Scope:** Cross-cutting architecture and conventions inherited by every phase, plus the phase decomposition.

---

## 1. Purpose and Scope

This is a **foundation spec**, not a whole-system spec. The full e-commerce backend is too large for a single implementable design; it decomposes into seven phases (§9), each of which gets its own spec → plan → implementation cycle.

This document fixes the decisions that span all phases so that no later phase re-litigates them. It produces two things:

1. **Binding conventions** — API surface, response and error contracts, data conventions, auth model, testing strategy, delivery strategy. These are mirrored into `CLAUDE.md` so they are enforced on every future change.
2. **Phase decomposition** — what each phase owns, what it depends on, and its definition of done.

Part of this spec is immediately implementable as **Phase F** (§9): the `common/` primitives, URI versioning, Prisma error mapping, the e2e test harness, and CI. The remainder is a contract that later specs consume.

**Out of scope:** auth endpoint design, product filtering, checkout logic, payment provider integration. Those belong to their own phase specs.

### Success criteria

The project is judged as both a **readable GitHub repository** and a **live deployed API** with public Swagger docs. This means infrastructure work (structured logging, readiness probes, deploy pipeline, seed data) is genuinely in scope rather than ceremony, but it is deferred to Phase 6 so it never competes with domain depth.

### Client assumption

The API is consumed via **Swagger UI and HTTP clients only**. There is no browser SPA. Consequences:

- Tokens are returned in JSON response bodies and sent as `Authorization: Bearer <token>`.
- No cookie-based auth, no CSRF protection, no `credentials: true` CORS handling.
- If a browser frontend is ever added, a cookie transport can be layered on top of the token-issuing service without reworking the auth core.

---

## 2. Architecture

### Layering

`controller → service → PrismaService`

Controllers stay thin: validate input via DTO, delegate to a service, map the result to a response DTO. Services hold business logic **and** their own Prisma queries. There is no repository layer.

**Rationale.** Prisma's client is already a data-access abstraction; wrapping it in a second one produces mostly pass-through methods, fights Prisma's type inference on partial selects, and makes transactions that span several entities awkward — which is precisely what Phase 3 checkout requires. The project's depth should come from hard problems (concurrent stock safety, webhook idempotency, cache invalidation), none of which a repository layer makes easier.

**Growth rule.** When a service grows too large, split it **by use case, not by layer**. Phase 3 introduces `CheckoutService` alongside `OrdersService`; it does not introduce `OrdersRepository`.

### Directory structure

```
src/
  main.ts                 bootstrap: helmet, CORS, versioning, pipes, filters, Swagger
  app.module.ts           composition root
  config/                 the ONLY place process.env is read
    configuration.ts
    env.validation.ts
  common/                 cross-cutting only — never domain logic
    filters/              http-exception.filter.ts
    guards/               jwt-auth.guard.ts, roles.guard.ts
    decorators/           public.decorator.ts, roles.decorator.ts, current-user.decorator.ts
    dto/                  pagination-query.dto.ts, paginated.dto.ts
    swagger/              api-paginated-response.decorator.ts
  prisma/                 PrismaService — the only PrismaClient instantiation
  modules/
    health/               exists
    users/                owns the User model and user records
    auth/                 owns credentials, tokens, guard wiring
    products/
    categories/
    cart/
    orders/
    payments/
test/
  factories/              shared fixture builders
  helpers/                truncate, app bootstrap
```

### Module boundaries

A module may depend on: its own files, `common/`, `config/`, `PrismaService`, and other modules' **explicitly exported providers** via NestJS module imports. Never another module's internal files.

### `users` is separate from `auth`

`UsersModule` owns the `User` model and exports `UsersService`. `AuthModule` owns credentials, hashing, tokens, and guards, and depends on `UsersService`.

**Rationale.** Later phases need to resolve a user record without importing JWT machinery — Phase 4 needs an email for payment receipts, for example. If `auth` owned the User model, every such module would transitively pull in the auth stack. Splitting now costs one file; splitting later is a cross-module refactor.

**Model ownership:** `UsersModule` owns `User`. `AuthModule` owns `RefreshToken`, since token persistence is a credential concern rather than a user-record concern.

**Scope discipline:** `UsersModule` ships **service-only** in Phase 1 — `findByEmail`, `findById`, `create`, and no controller. `GET /auth/me` lives in `auth`, because it concerns the authenticated principal rather than user administration. A `UsersController` is added only when genuine user-administration endpoints are needed.

### Global authentication guard

`JwtAuthGuard` is registered globally via `APP_GUARD`. Routes opt out with `@Public()`.

**Rationale.** The two options fail in opposite directions. Per-route `@UseGuards()` fails **open** — a forgotten decorator silently ships an unauthenticated endpoint. A global guard fails **closed** — a forgotten `@Public()` makes login return 401 on the first test run. One failure mode is a production security hole; the other is a red test within seconds.

**Costs, accepted:** protected routes need `@ApiBearerAuth()` for Swagger to attach the token; `/health` and the auth entry points need explicit `@Public()`.

**Regression test (required):** an e2e test boots the app, calls a protected route with no token, and asserts 401. This catches removal of the `APP_GUARD` provider during a future refactor, which would otherwise open every route silently.

---

## 3. API Surface

- Global prefix `api`, plus Nest URI versioning with default version `1`.
- Routes: `/api/v1/auth/login`, `/api/v1/products`, `/api/v1/orders`, …
- `/health` is excluded from both prefix and versioning, so infrastructure probes and load balancers have a stable path.
- Swagger UI stays at `/api/docs`.
- REST, resource-based, plural nouns.
- Every endpoint carries `@ApiTags`, `@ApiOperation`, and `@ApiResponse` decorators.

---

## 4. Request Validation

The global `ValidationPipe` keeps `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`, and adds `transformOptions: { enableImplicitConversion: false }`.

**Rationale.** Implicit conversion produces surprising coercions — `?limit=abc` becomes `NaN` rather than a validation error. DTOs declare conversions explicitly with `@Type(() => Number)`.

Every mutating endpoint requires a validated DTO. Raw request bodies are never trusted.

---

## 5. Response and Error Contracts

### Success responses

**Single resources** are returned bare:

```json
{ "id": "0192...", "name": "Desk Lamp", "priceCents": 4999, "currency": "USD" }
```

**Collections** are wrapped with pagination metadata:

```json
{
  "data": [ { "id": "..." }, { "id": "..." } ],
  "meta": { "page": 2, "limit": 20, "total": 137, "totalPages": 7 }
}
```

There is no global response-envelope interceptor. The wrapper is the declared return type of list endpoints, which keeps Swagger schemas honest and avoids indirection on every route.

### Serialization rule

**Controllers never return Prisma model objects directly.** Each module defines response DTOs with a static `from()` mapper.

**Rationale.** Prisma returns plain JavaScript objects, not class instances. `@Exclude()` combined with `ClassSerializerInterceptor` therefore does nothing unless the object is first passed through `plainToInstance`. Relying on it would silently serialize `passwordHash` to clients. Explicit mapping is the only approach that actually holds.

### Pagination primitives

`common/dto/pagination-query.dto.ts`:

- `page`: integer, minimum 1, default 1
- `limit`: integer, minimum 1, maximum 100, default 20

`common/dto/paginated.dto.ts` defines `PaginatedDto<T>` with `data` and `meta`. Because Swagger cannot infer generic types, `common/swagger/api-paginated-response.decorator.ts` provides an `@ApiPaginatedResponse(Model)` helper that composes the schema explicitly.

Pagination is **offset-based** (page/limit). Cursor pagination is not used: the catalog size does not require it, and page numbers are far easier to exercise from Swagger UI.

### Error responses

The existing shape is retained for every error:

```json
{
  "statusCode": 409,
  "message": "Email already registered",
  "error": "Conflict",
  "timestamp": "2026-08-12T10:00:00.000Z",
  "path": "/api/v1/auth/register"
}
```

`HttpExceptionFilter` gains **Prisma error mapping**:

| Prisma code | HTTP | Meaning |
|---|---|---|
| `P2002` | 409 Conflict | Unique constraint violation |
| `P2025` | 404 Not Found | Record required but not found |
| `P2003` | 409 Conflict | Foreign key constraint violation |
| anything else | 500 | Message replaced with `"Internal server error"` |

**Rationale.** Without mapping, a duplicate-email registration surfaces as a 500 carrying Prisma internals. 5xx responses continue to log the stack server-side while returning a generic message to the client.

---

## 6. Data Conventions

- **Primary keys:** UUID v7 strings (`@default(uuid(7))`). Time-sortable, so index locality does not degrade the way random UUID v4 does under insert load. Verified supported on the installed Prisma 6.19.3.
- **Money:** integer minor units — `priceCents Int`, plus a `currency String @default("USD")`. Floating-point money is banned everywhere. This matches what Stripe expects, so Phase 4 requires no conversion at the provider boundary. The API exposes cents; formatting is the client's concern.
- **Timestamps:** every model has `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt`.
- **Naming:** Prisma models are PascalCase singular with camelCase fields; `@@map` and `@map` render snake_case plural tables and snake_case columns in the database.
- **Enums:** native Prisma enums — `Role`, `OrderStatus`, `PaymentStatus`.
- **Soft delete:** applied only where history requires it (`Product.isActive`, so historical orders retain valid product references). There is no global soft-delete mechanism.
- **Model ownership:** a model is introduced only in the phase that owns it.
- **Migrations:** created via `prisma migrate dev`, committed to git, and never edited retroactively once applied. The database is never hand-edited.

---

## 7. Security Model

Detailed endpoint design belongs to the Phase 1 spec. The foundation commits to:

- **Password hashing:** Argon2id.
- **Access tokens:** JWT, short-lived (~15 minutes), signed with `JWT_SECRET`.
- **Refresh tokens:** long-lived (~7 days), **persisted hashed and rotated on every use**. Rotation with reuse detection revokes the whole token family. Revocability is the point — it makes logout meaningful and enables response to a leaked token.
- **Authorization:** `Role` enum (`CUSTOMER`, `ADMIN`) enforced by `RolesGuard` with a `@Roles()` decorator.
- **Rate limiting:** `@nestjs/throttler` applied globally from Phase 1 using in-memory storage, with stricter limits on auth endpoints. Phase 5 swaps the storage backend to Redis so limits hold across instances.
- **Secrets:** read only from environment variables, validated by Joi at boot. Never hardcoded, never logged. Passwords and tokens are never logged at any level.
- **Transport hardening:** `helmet()` and config-driven CORS remain mandatory in `main.ts`.
- **Error leakage:** client-facing errors never contain stack traces, SQL, or raw exception messages.

---

## 8. Testing Strategy

### Unit tests

Every service containing business logic gets unit tests with `PrismaService` and other dependencies mocked. Located beside the code as `*.spec.ts`.

### End-to-end tests

- A **second Postgres service** in `docker-compose.yml` on port `5433`, database `ecommerce_test`, addressed by `TEST_DATABASE_URL`.
- A Jest **global setup** runs `prisma migrate deploy` against the test database once per run.
- A `truncateAll()` helper issues `TRUNCATE ... RESTART IDENTITY CASCADE` across all tables between tests.

**Rationale for truncation over alternatives.** Per-test transaction rollback is faster but breaks precisely where correctness matters most: Phase 3 checkout opens its own `$transaction`, and nesting it inside a test transaction does not reproduce production behaviour. Testcontainers is more hermetic but adds a dependency and ~10–20s of startup to every run. Truncation is fast, simple, and behaviourally identical to production.

- Shared fixture builders live in `test/factories/` so phases do not reinvent user and product fixtures. These arrive in Phase 1 alongside the first model; Phase F ships only the harness (`test/helpers/`), since there is nothing to build fixtures for yet.
- Every new endpoint gets at least one e2e test.
- Critical flows — auth, orders, payments — require e2e coverage.

### Gate

`npm run lint`, `npm run build`, and `npm test` must pass before any change is considered done. `npm run test:e2e` is additionally required whenever a change touches anything DB-dependent.

---

## 9. Phase Decomposition

| Phase | Owns | New models | Depends on |
|---|---|---|---|
| 0 ✅ | Scaffold, config validation, Prisma wiring, health check, Swagger, Docker | — | — |
| **F** | Versioning, `common/` primitives, Prisma error mapping, e2e harness, CI | — | 0 |
| 1 | Authentication, guards, roles | `User`, `RefreshToken` | F |
| 2 | Products and categories | `Product`, `Category` | 1 |
| 3 | Cart and orders | `Cart`, `CartItem`, `Order`, `OrderItem` | 1, 2 |
| 4 | Payments and webhooks | `Payment` | 3 |
| 5 | Redis caching, BullMQ jobs | — | 2, 3, 4 |
| 6 | Observability, CI hardening, seeds, deployment | — | all |

**Phase F exists because** the foundation work is itself implementable and must land before auth, so Phase 1 builds on finished primitives rather than inventing them mid-flight.

### Phase F — definition of done

1. URI versioning enabled; all future routes resolve under `/api/v1/*`; `/health` still answers at `/health`.
2. `common/dto/pagination-query.dto.ts`, `common/dto/paginated.dto.ts`, and `@ApiPaginatedResponse()` exist with unit tests.
3. `HttpExceptionFilter` maps `P2002`, `P2025`, and `P2003`, with unit tests for each.
4. `ValidationPipe` sets `enableImplicitConversion: false`.
5. `docker-compose.yml` runs a test Postgres on `5433`; `TEST_DATABASE_URL` is added to `.env.example` and the Joi schema.
6. Jest global setup migrates the test database; `truncateAll()` and `createTestApp()` exist in `test/helpers/`. (`test/factories/` is deferred to Phase 1, when the first model exists.)
7. GitHub Actions runs lint → build → unit tests → e2e against a Postgres service container.
8. `CLAUDE.md` is updated with the conventions in this spec, replacing the deferred-versioning note.

### Explicitly excluded from the roadmap

Reviews, wishlists, coupons, shipping-provider integration, and multi-vendor support. Each adds surface area without demonstrating anything the seven phases do not already cover. The project optimises for depth and correctness over feature breadth.

---

## 10. Delivery

- **Deploy unit:** the existing multi-stage `Dockerfile`, which already runs as a non-root user.
- **Host:** a managed PaaS (Railway, Render, or Fly.io) with managed Postgres and Redis add-ons. Selected in Phase 6; nothing in the design is host-specific.
- **Migrations:** `prisma migrate deploy` runs as a discrete release command, never at application boot. Running migrations at boot races across replicas and couples schema changes to process start.
- **Configuration:** strictly 12-factor. `src/config/` is the only reader of `process.env`. Any new environment variable is added to `.env.example` and the Joi schema in `src/config/env.validation.ts` in the same commit that introduces it.
- **CI:** GitHub Actions on every push and pull request — lint, build, unit tests, e2e against a Postgres service container.

---

## 11. Decisions Log

| Decision | Choice | Key reason |
|---|---|---|
| Judged as | Repo **and** live demo | Infrastructure work is justified rather than ceremonial |
| Client | Swagger/HTTP only | No cookie or CSRF surface needed |
| Routing | `/api/v1/*`, `/health` unprefixed | Stable probe path; versioning cheap to add now, costly later |
| Success shape | Bare resources, wrapped collections | No indirection; pagination meta where it is meaningful |
| Money | Integer cents | Exact arithmetic; matches the Stripe boundary |
| Test isolation | Separate test DB + truncate | Compatible with Phase 3's own transactions |
| Hosting | Managed PaaS | Working public URL for minimal ops effort |
| Layering | Services own Prisma queries | Idiomatic; depth belongs in hard problems, not indirection |
| `users` vs `auth` | Split, service-only initially | Avoids dragging JWT machinery into later modules |
| Guard registration | Global with `@Public()` opt-out | Fails closed instead of open |
| Serialization | Explicit response DTOs | `@Exclude()` silently no-ops on Prisma's plain objects |
