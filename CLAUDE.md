# CLAUDE.md

Guidance for working on this repository. This project is built **phase by phase** — read this before making any change.

## Project Purpose

A production-grade e-commerce backend, built as a portfolio project for a backend developer job search. The goal is to demonstrate clean architecture, security awareness, and test discipline — not feature breadth. Depth and correctness over speed.

## Tech Stack

- Node.js 20 + TypeScript (strict mode)
- NestJS
- PostgreSQL + Prisma ORM
- Redis + BullMQ (caching / background jobs — not yet introduced)
- `@nestjs/jwt` — access tokens (HS256)
- `@node-rs/argon2` — password hashing (Argon2id)
- `@nestjs/throttler` — rate limiting (in-memory; Redis-backed storage waits for Phase 5)
- Docker / docker-compose
- Jest (unit + e2e)
- Swagger (OpenAPI docs served at `/api/docs`)

## Architecture Principles

- Modular, domain-oriented structure under `src/modules/*`; each module owns its controllers, services, and DTOs.
- `src/common/` is for cross-cutting concerns only (filters, interceptors, guards, pipes) — never domain/business logic.
- `src/config/` is the single place that reads `process.env`. Nothing else should call `process.env` directly.
- `src/prisma/` is the only database access layer. `PrismaService` is the only place `PrismaClient` is instantiated.
- Fail fast: invalid/missing env vars abort boot (via Joi validation), errors are never swallowed silently.
- Nothing is implemented ahead of its phase (see Important Constraints).
- All application-level configuration (helmet, CORS, prefix, versioning, pipes, filters, shutdown hooks) lives in `configureApp()` in `src/bootstrap.ts`, so runtime and e2e tests are configured identically. `main.ts` owns only Swagger and `listen()`.

## Module Boundaries

- Feature modules live at `src/modules/<domain>/` (currently: `health`; future: `auth`, `products`, `orders`, `payments`, ...).
- A module may depend on: its own files, `src/common`, `src/config`, `src/prisma` (via `PrismaService`), and other modules' explicitly exported providers through NestJS module imports — never by reaching into another module's internal files directly.
- Controllers stay thin: validate input via DTO, delegate to a service, shape the response. Business logic belongs in services.

## Coding Conventions

- Strict TypeScript (`strict: true`) everywhere. Avoid `any`; if unavoidable, comment why.
- ESLint + Prettier are enforced — `npm run lint` must be clean before a change is considered done.
- Request input is validated with `class-validator` DTOs — never trust a raw request body.
- Public methods have explicit return types.
- No unused locals/parameters (enforced by `tsconfig.json`).

## Security Requirements

- Never hardcode secrets or credentials. All configuration comes from environment variables, validated in `src/config/env.validation.ts`.
- `.env` is gitignored and never committed. `.env.example` must stay in sync with every env var actually read by the app.
- `helmet()` and config-driven CORS in `configureApp()` (`src/bootstrap.ts`) are mandatory — don't remove or bypass them.
- Every mutating endpoint requires a validated DTO; the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) must stay enabled.
- Client-facing errors never leak internals (stack traces, SQL, raw exception messages) — always go through `HttpExceptionFilter`.

### Authentication (Phase 1 — implemented)

- **Argon2id for passwords, SHA-256 for refresh tokens. Never swap these.** Argon2 exists to make *low-entropy* secrets expensive to guess; a refresh token is 256 bits of CSPRNG output with no dictionary to defend against. More decisively, a *salted* Argon2 digest cannot be looked up by hash — and reuse detection requires exactly that lookup. Using Argon2 here would break the security feature it appears to strengthen.
- **Access tokens are HS256 carrying `{ sub, role }` only.** No `email`: bearer tokens surface in proxy logs, CDN logs, and error-tracker breadcrumbs that the "never log tokens" rule cannot reach, so every unused claim is free PII exposure. `role` stays because Phase 2's `RolesGuard` reads it. `/auth/me` refetches the user from the database rather than trusting the token's copy.
- **Refresh tokens rotate on every use.** Presenting an already-consumed token revokes the **entire family** and returns 401 — a consumed token is indistinguishable from a replayed steal, so we assume compromise. Expired tokens do **not** revoke the family: an expired token is evidence of a slow client, not theft, and revoking there would log honest users out on a clock skew.
- **`JwtAuthGuard` is global and fails closed.** A route without `@Public()` is protected. `@Public()` lives in `src/common/decorators/` (consumed by `HealthModule` and test fixtures); the guard lives in `src/modules/auth/guards/` because it injects `TokenService` — putting it in `common/` would make the cross-cutting layer depend on a feature module.
- **`POST /auth/refresh` must stay `@Public()`.** The caller's access token is expired by definition — that is why they are refreshing. The refresh token is the credential, validated inside the service. Marking this route protected locks every user out permanently, and it is an easy mistake because the endpoint *feels* like it should be authenticated.
- **`login` verifies the password above the `!user` branch, unconditionally.** Both paths must pay one argon2 hash or login becomes an email-enumeration oracle. The dummy digest is **derived at boot** (`onModuleInit` hashes random bytes through the real hasher), never hardcoded: argon2 reads its cost parameters `m/t/p` *from the digest being verified*, so a constant generated under different parameters would silently make the unknown-email path cheaper while every functional test stayed green. Reordering these two statements reopens the oracle.
- **Unknown email, wrong password, and unknown/expired/replayed refresh tokens all return identical 401s.** One rejection constant per service; do not add a more specific message.
- **Never log a password, a digest, or a token** at any level.
- Rate limiting: 100 req/min globally, 5 req/min on `register`, `login`, and `refresh`. `ThrottlerGuard` is registered **before** `JwtAuthGuard` so an unauthenticated flood is rejected before any token verification or database work. Do not reorder them.

## Testing Requirements

- Every service containing business logic gets unit tests (mock `PrismaService` and other dependencies).
- Critical flows (auth, orders, payments once they exist) require e2e coverage in `test/`.
- New endpoints get at least one e2e test against a real (dockerized) Postgres instance.
- `npm test` and `npm run test:e2e` must pass before a feature is considered complete.
- E2E tests run against a dedicated Postgres on port 5433 (`docker compose up -d postgres-test`), addressed by `TEST_DATABASE_URL`. `test/setup-e2e.ts` redirects `DATABASE_URL` per worker; `test/global-setup.ts` applies migrations once per run.
- Use `createTestApp()` from `test/helpers/create-test-app.ts` so tests exercise the real pipes, filters, prefix, and versioning.
- Reset state between tests with `truncateAll()` from `test/helpers/truncate.ts`.
- The e2e suite runs serially (`maxWorkers: 1` in `test/jest-e2e.json`). `truncateAll()` reads `pg_tables` and builds a `TRUNCATE` from the result with no lock between the two statements, so concurrent workers sharing one database can race — confirmed to fail intermittently on a cold cache. Do not raise `maxWorkers` until per-worker database isolation exists.
- Test factories (`test/factories/`) must insert rows through the Prisma client, never `$executeRaw`/`$queryRaw`. IDs use `@default(uuid(7))`, which Prisma generates client-side — the migration's SQL has no database-level default, so a raw insert gets no id.
- `test/` is the one place outside `src/config/` allowed to read `process.env` directly — it must configure the environment before the app boots.

### Throttling and guards in tests — non-obvious mechanics

These were each established empirically; a future session will otherwise rediscover them the hard way.

- **Register one throttler, never two.** `ThrottlerGuard` evaluates *every* configured throttler on *every* request, so adding a second named entry at a stricter limit would silently cap unrelated routes too. Stricter auth limits come from a per-route `@Throttle()` override of the same throttler.
- **The `@Throttle()` key must be `default`** — that is the name `ThrottlerModule.forRoot` assigns when none is given. Any other key is ignored silently.
- **`overrideGuard()` is a silent no-op against an `APP_GUARD`-registered guard.** It only replaces providers Nest considers "injectables", and `APP_GUARD` providers live under a synthetic token in the module's provider list. This is why `AppModule` registers `ThrottlerGuard` under its own class token and aliases it with `useExisting` — so `overrideProvider(ThrottlerGuard)` has a real target. Use `overrideProvider()`, not `overrideGuard()`.
- **`createTestApp([], { throttleLimit })` is a boolean trigger, not a numeric cap.** Any defined value (including `0`) replaces the guard entirely. Suites issuing heavy auth traffic must pass it, or they 429 partway through and the failures masquerade as auth bugs. Omit it to exercise the real production limits — `auth-throttle.e2e-spec.ts` depends on that default.

## Database Conventions

- All schema changes go through `prisma/schema.prisma` + `prisma migrate dev`. Never hand-edit the database.
- A model is added only in the phase that owns it (e.g. the `Product` model arrives with the products module, not before).
- The database is accessed only through `PrismaService` — no ad hoc `pg` clients or raw connections elsewhere.
- Migrations are committed to git and never edited retroactively once applied/merged.
- Primary keys are UUID v7 strings (`@default(uuid(7))`).
- Money is stored as integer minor units (`priceCents Int`) plus a `currency` field. Floating-point money is banned.
- Every model carries `createdAt` and `updatedAt`.
- Models are PascalCase singular with camelCase fields; `@@map`/`@map` render snake_case plural tables.

## API Conventions

- Every endpoint is documented with Swagger decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse`).
- REST, resource-based routes with plural nouns (`/health`, `/products`, `/orders`, ...).
- Consistent error response shape from `HttpExceptionFilter`: `{ statusCode, message, error, timestamp, path }`.
- Global prefix `api` + URI versioning, default version `1` — all domain routes live under `/api/v1/*`.
- `/health` is excluded from both the prefix and versioning (`VERSION_NEUTRAL`) so infrastructure probes have a stable path.
- Single resources are returned bare; collections are wrapped as `{ data, meta }` using `PaginatedDto` from `src/common/dto/`.
- Controllers never return Prisma model objects directly — each module defines response DTOs with a static `from()` mapper. `@Exclude()` silently does nothing on Prisma's plain objects, so explicit mapping is the only thing that actually prevents field leaks.
- List endpoints accept `PaginationQueryDto` and document their response with `@ApiPaginatedResponse(Model)`.

## Git Conventions

- Clear, descriptive commit messages; never commit `.env`, secrets, or generated output (`dist/`, `coverage/`, `node_modules/`).
- Only commit when explicitly asked to — do not commit proactively.
- Keep commits scoped to the phase/task being worked on.

## Important Constraints

- Build phase by phase. Do not implement the whole project, or a future phase's domain (products, orders, payments, Redis/BullMQ), ahead of being asked.
- **`RolesGuard` and `@Roles()` are Phase 2, and must ship in the same change as an admin-bootstrap path.** Nothing in Phase 1 writes `role` — registration hardcodes `CUSTOMER` — so a guard shipped alone protects routes no real account can reach, is exercisable only through a test factory, and would leave a deployed API with no administrator. Treat this as a Phase 2 entry condition, not a follow-up.
- Do not add dependencies beyond what the current phase actually needs.
- Do not modify files unrelated to the current task/phase.
- Explain architectural decisions before implementing them — get alignment first, especially for anything affecting shared structure (config, common, prisma).

## Rules to Follow When Modifying This Project

1. Confirm which phase a change belongs to before writing code for it. If unclear, ask rather than assume.
2. Never hardcode a secret; if a new env var is needed, add it to both `.env.example` and the Joi schema in `src/config/env.validation.ts`.
3. Before calling a change done: `npm run lint`, `npm run build`, `npm test` must pass; run `npm run test:e2e` too when the change touches anything DB-dependent.
4. Do not loosen `tsconfig.json` strictness or disable an ESLint rule to make an error go away — fix the underlying issue.
5. Stay inside the current task's module/domain — don't touch unrelated modules "while you're in there."
6. Update this file when architecture, conventions, or constraints actually change.
