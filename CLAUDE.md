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
- ESLint + Prettier are enforced — `npm run lint:ci` must be clean before a change is considered done (`lint`'s `--fix` would repair the violation instead of reporting it).
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
- **Consuming a refresh token must stay atomic.** `rotate()` claims the token with a compare-and-swap — `updateMany({ where: { id, revokedAt: null } })` — and treats `count === 0` as reuse. Do not "simplify" this back to `update({ where: { id } })`: the predicate has to travel *with* the write. Reading the row, checking `revokedAt`, then updating lets two concurrent requests both read `null`, both pass the check, and both rotate — two live tokens in one family, and the reuse detection above never fires. Verified empirically: the old sequence consumed one token twice. No lock and no transaction is needed, and none may be held across JWT signing.
- **`JwtAuthGuard` is global and fails closed.** A route without `@Public()` is protected. `@Public()` lives in `src/common/decorators/` (consumed by `HealthModule` and test fixtures); the guard lives in `src/modules/auth/guards/` because it injects `TokenService` — putting it in `common/` would make the cross-cutting layer depend on a feature module.
- **`POST /auth/refresh` must stay `@Public()`.** The caller's access token is expired by definition — that is why they are refreshing. The refresh token is the credential, validated inside the service. Marking this route protected locks every user out permanently, and it is an easy mistake because the endpoint *feels* like it should be authenticated.
- **`login` verifies the password above the `!user` branch, unconditionally.** Both paths must pay one argon2 hash or login becomes an email-enumeration oracle. The dummy digest is **derived at boot** (`onModuleInit` hashes random bytes through the real hasher), never hardcoded: argon2 reads its cost parameters `m/t/p` *from the digest being verified*, so a constant generated under different parameters would silently make the unknown-email path cheaper while every functional test stayed green. Reordering these two statements reopens the oracle.
- **Unknown email, wrong password, and unknown/expired/replayed refresh tokens all return identical 401s.** One rejection constant per service; do not add a more specific message.
- **Never log a password, a digest, or a token** at any level.
- Rate limiting: 100 req/min globally, 5 req/min on `register`, `login`, and `refresh`. `ThrottlerGuard` is registered **before** `JwtAuthGuard` so an unauthenticated flood is rejected before any token verification or database work. Do not reorder them.

### Products and authorization (Phase 2 — implemented)

- **`RolesGuard` is opt-in; `JwtAuthGuard` is opt-out.** A route with no `@Roles()` is reachable by any authenticated caller. This asymmetry is deliberate: authentication has a safe universal default, authorization does not — a fail-closed roles guard would need an invented required role for every route, including the public catalog. The mitigation is structural: all admin routes live on a controller carrying a single class-level `@Roles(Role.ADMIN)`, and every write route asserts 403 in e2e.
- **Guard order is `ThrottlerGuard → JwtAuthGuard → RolesGuard`** and is registration-order dependent in `AppModule`. `RolesGuard` reads `request.user`, which `JwtAuthGuard` populates; reversing them turns a 401 into a misleading 403. `RolesGuard` is registered under its own class token and aliased with `useExisting`, like `JwtAuthGuard`, so `overrideProvider()` can target it — `overrideGuard()` silently no-ops.
- **`@Roles()` lives in `common/decorators/`, `RolesGuard` in `modules/auth/guards/`.** The decorator is dependency-free metadata; the guard consumes `AuthenticatedUser`, so placing it in `common/` would make the cross-cutting layer depend on a feature module.
- **`ProductsService` read methods take a required `visibility` argument.** Never give it a default. A caller that forgets it must fail to compile — the failure being guarded against is a future phase quietly reading deactivated products into an order, which a safe default would hide. Both public read routes pass the literal `'active-only'`; admin writes are the only path to an inactive product. The public detail route returns **404** for an inactive product: outside the requested visibility reads as absent, not as hidden.
- **`DELETE` is soft deactivation, never a hard delete.** It sets `isActive = false`; the row is never removed, because Phase 3's orders must keep valid product references. Reactivation is `PATCH { "isActive": true }`.
- **`Product.category` is `onDelete: Restrict`, never `Cascade`.** Deleting a category must not delete its products; the FK violation surfaces as `P2003` → 409. Category deletion is deliberately not implemented — it needs an orphan policy. `Product.categoryId` is required; there is no product without a category.
- **Sort fields are a whitelist enum validated by `@IsEnum`.** An unlisted value is rejected with 400 by the global pipe and never reaches Prisma as an `orderBy` key. Do not accept a free-form sort string.
- **`priceCents` is an integer in minor units everywhere** — DTOs, Swagger examples, responses. No floating-point price, ever. Because `enableImplicitConversion` is `false`, every numeric query or body field needs an explicit `@Type(() => Number)` or it arrives as a string.
- **`UpdateProductDto` is written out in full, not derived with `PartialType(CreateProductDto)`** — `PartialType` would silently drop `isActive` and take the reactivation path with it.
- **Prisma errors are never caught in a service or controller.** `P2002` → 409, `P2003` → 409, `P2025` → 404 are mapped in one place, `HttpExceptionFilter`. Catching and re-throwing locally produces the same error twice with two different messages.
- **The pagination primitives were assessed against real consumers and deliberately not reshaped** (Phase 2 spec §8.2). `PaginationQueryDto`, `PaginatedDto`, and `@ApiPaginatedResponse` are still at their original Phase 1 commits. Do not reshape them without new evidence from a real consumer.
- **`UsersService.ensureAdmin()` never rewrites an existing `passwordHash`.** It creates, promotes, or does nothing. Promotion and password reset are different operations and only the first ships. `CreateUserInput` still has no `role` field — registration cannot mint an ADMIN, and that stays true.
- **The admin bootstrap is a compiled script, not a Prisma seed.** The runtime image installs with `--omit=dev`, so neither the `prisma` CLI nor `ts-node` exists there; `node dist/scripts/bootstrap-admin.js` runs with zero extra dependencies. It reads config through `ConfigService`, so `src/config/` remains the only reader of `process.env`. CI runs the compiled command twice and diffs `password_hash` across runs.
- **Phase 2 ships no category write route, and this is a known, undischarged gap** (`docs/deferred-limitations.md`), not an oversight to "fix" in passing. `POST /admin/products` requires a pre-existing `categoryId`, so until a category is seeded out-of-band, every admin product create 409s. Deactivation has the matching gap: a deactivated product's id is recoverable only by a caller who already holds it, since there is no admin list route to rediscover it. Don't add either route as a drive-by while working on something else — it needs its own task, and the deferred-limitations entry closes by shipping it, not by editing the entry.

### Cart, orders, and checkout (Phase 3 — implemented)

- **Stock decrement is a conditional `updateMany` whose predicate travels with the write, in `ProductsService.decrementStock()`.** Never a read, a check, then an update — same idiom as `RefreshTokenService.rotate()`. PostgreSQL re-evaluates the `WHERE` (`isActive: true`, `stockQuantity: { gte: quantity }`) against the committed row before writing, so a decrement racing past a concurrent one on stale data simply matches zero rows instead of overselling.
- **Product row locks are taken in ascending `productId` order**, in both `CheckoutService.checkout()` and `OrdersService.cancel()`. Unsorted locks are the classic deadlock shape — two carts holding the same two products in opposite order — and sorted acquisition makes hold-and-wait impossible by construction; that is a structural argument from PostgreSQL row-lock semantics, **not** a result this harness reproduced (see the C3 entry below). `checkout()` re-sorts `sortedItems` itself rather than trusting `CartService.listItemsForCheckout()`'s own `orderBy` — the lock order must not depend on a caller remembering to ask for one.
- **Prices and names are snapshotted only after every product lock in the order is held** — `ProductsService.findManyForSnapshot()` runs after the decrement loop in `checkout()`, never before. Reading prices first would let an admin's committed price change land between the read and the order insert.
- **The `Cart` row exists to be locked.** `CartService.lockForUpdate()` — a `cart.upsert` whose `update` branch takes the row lock — runs first in every cart mutation and every checkout. Deleting the model to "simplify" (folding it into `CartItem.userId`) reopens one-cart-two-orders: two concurrent checkouts by the same user with different idempotency keys would both read the same items and both decrement stock.
- **The idempotency lookup lives inside the transaction, after the cart lock.** `CheckoutService.checkout()` runs `tx.order.findUnique({ userId_idempotencyKey })` only once the cart row lock is held. Moving it earlier makes a concurrent replay see the already-cleared cart and wrongly return 409 "Cart is empty" instead of replaying the committed order.
- **Cancellation claims the order with a `PENDING` predicate** — `tx.order.updateMany({ where: { id, userId, status: PENDING } })` in `OrdersService.cancel()` — so restoration is exactly-once: only the request whose CAS actually matched increments stock. Racing cancels all return 200; only one restores.
- **Restocking is relative, never absolute.** `ProductsService.adjustStock()` (`POST /admin/products/:id/stock-adjustments`) uses the same CAS family. `UpdateProductDto` must never gain `stockQuantity` — an absolute write from a stale read is a lost update that silently erases a concurrent sale.
- **`PUT /cart/items/:id` sets the quantity, never increments (D11).** `CartService.setItem()`'s upsert writes the literal `quantity` in both its `create` and `update` branches. There is no add-to-cart route that increments a line, and none is to be introduced.
- **`stockQuantity` is public on `ProductResponseDto`, by decision (D10, spec §4.1.1), not by accident of DTO reuse.** Both public catalog routes return it. Removing it from the public catalog is a product decision, not a cleanup.
- **`describeRefusal()` explains a refusal that already happened and never authorises a sale.** It is called only after `decrementStock()` returns `count === 0`, stays in `ProductsService` (the products table's one owning module), never throws, and takes `tx` as a required parameter so it reads inside the caller's transaction. `findOne(id, 'all')` must not replace it: `findOne()` throws `NotFoundException`, which would surface as a misleading 404 on `POST /orders` instead of checkout's own 409, and it queries `this.prisma` rather than the caller's `tx`.
- **No external I/O runs inside the checkout transaction** — no HTTP call, no token signing, no argon2. Phase 4's payment call happens after commit. Same rule as Phase 1's "never hold a lock across JWT signing," restated for the money path.
- **`P2028`, `P2034`, and the Phase 3 `CHECK` constraints are deliberately left unmapped in `HttpExceptionFilter`.** A logged 500 is the correct signal for transaction saturation or a broken invariant, not a friendly 4xx that would hide it.
- **Concurrency tests ship only after a recorded negative control fails against a naive implementation** (design spec §11) — a green concurrency run alone is never evidence. **C3 is the recorded exception, and its framing must not be strengthened**: neither the prescribed unsorted-lock control nor a stronger control that removed every sort on the path reproduced a deadlock in this harness. That proves only that the shipped code did not deadlock under the load tested — it does **not** independently prove sorted lock acquisition is the mechanism preventing a deadlock that would otherwise occur. The lock-ordering rule above stays mandatory as a discipline, not as a proven mechanism.
- **Concurrency e2e suites `await app.listen(0)` in setup** (`test/checkout-concurrency.e2e-spec.ts`) so `Promise.all` can fire real parallel HTTP requests against one server — the existing unlistened-server pattern throws `ERR_SERVER_ALREADY_LISTEN` under concurrent calls. They pass `createTestApp([], { throttleLimit: 0 })` and mint tokens directly via `app.get(TokenService).signAccessToken(user)`, never through `/auth/login`, so the 5/min auth throttle is never in the loop, and every test asserts no response is a 500.
- **Only one `npm run test:e2e` run may hold the test database at a time.** `test/helpers/e2e-lock.ts` takes a session-scoped Postgres advisory lock for the run and throws immediately if another run already holds it — a second concurrent run's `truncateAll()` and the first run's in-flight requests otherwise corrupt each other. A refusal here means another run is active, not a bug; wait for it to finish or point `TEST_DATABASE_URL` elsewhere.
- **`maxWorkers: 1` stays.** Phase 3 adds no per-worker isolation, and the concurrency suites additionally depend on being the database's only occupant (see the advisory-lock rule above).
- **`npm run lint:ci`, not `npm run lint`, is the gate.** `lint`'s `--fix` silently repairs a violation before anyone sees it; `lint:ci` runs `--max-warnings 0` with no autofix, which is what CI actually runs.

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
- **`RolesGuard` and `@Roles()` shipped in Phase 2, in the same change as the admin-bootstrap path.** Nothing in Phase 1 wrote `role` — registration hardcodes `CUSTOMER` — so a guard shipped alone would have protected routes no real account could reach, been exercisable only through a test factory, and left a deployed API with no administrator. That entry condition was satisfied in a single commit alongside the guard, not spread across follow-ups.
- Accepted gaps live in `docs/deferred-limitations.md` — trusted-proxy/rate-limiting, refresh-token purge, runtime-image Prisma, and the `maxWorkers: 1` constraint. Check it before assuming something is an oversight, and close an entry by shipping the fix, never by deleting it.
- Do not add dependencies beyond what the current phase actually needs.
- Do not modify files unrelated to the current task/phase.
- Explain architectural decisions before implementing them — get alignment first, especially for anything affecting shared structure (config, common, prisma).

## Rules to Follow When Modifying This Project

1. Confirm which phase a change belongs to before writing code for it. If unclear, ask rather than assume.
2. Never hardcode a secret; if a new env var is needed, add it to both `.env.example` and the Joi schema in `src/config/env.validation.ts`.
3. Before calling a change done: `npm run lint:ci`, `npm run build`, `npm test` must pass; run `npm run test:e2e` too when the change touches anything DB-dependent.
4. Do not loosen `tsconfig.json` strictness or disable an ESLint rule to make an error go away — fix the underlying issue.
5. Stay inside the current task's module/domain — don't touch unrelated modules "while you're in there."
6. Update this file when architecture, conventions, or constraints actually change.
