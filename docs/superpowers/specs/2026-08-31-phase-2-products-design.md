# Phase 2 — Products, Categories, and Authorization Design Spec

**Date:** 2026-08-31 · **Revised:** 2026-09-01
**Status:** **Approved with clarifications** — authoritative. No implementation has started.
**Base:** `master` @ `38090f6` (Phase 1 merged via PR #5, CI green)
**Owns:** `Product`, `Category`, `RolesGuard`, `@Roles()`, admin bootstrap

> Reviewed and approved 2026-09-01, in two rounds. The fifteen review decisions are recorded in **§17**, which is the authority where any ambiguity remains. Four questions previously open in §16 were closed by those rounds; two remain open, and neither blocks planning.

---

## 1. Purpose and scope

Phase 2 delivers the product catalog and the authorization layer that guards it.

Phase 1 answered *who is the caller*. Phase 2 answers *what is the caller allowed to do* — and, because nothing in Phase 1 can produce an `ADMIN`, it must also answer *how does the first administrator come to exist*. Those two questions ship together or not at all (§4).

### In scope

1. `Category` and `Product` models plus one migration.
2. `CategoriesModule` and `ProductsModule` — services, controllers, request DTOs, response DTOs with static `from()` mappers.
3. Public catalog reads: product list (paginated, filtered, sorted), product detail, category list.
4. Admin catalog writes and admin-visible reads.
5. `@Roles()` decorator, `RolesGuard`, and their registration in the global guard chain.
6. **Admin bootstrap** — a real production path to an `ADMIN` account.
7. First real consumers of the `common/` pagination primitives, with an explicit fit assessment.
8. Unit and e2e coverage, including a full authorization matrix.
9. Documentation updates: `CLAUDE.md`, `README.md`.

### Out of scope

Cart and orders (Phase 3), payments (Phase 4), Redis/BullMQ and catalog caching (Phase 5), observability and deployment hardening (Phase 6).

Permanently excluded by the foundation spec's roadmap: reviews, wishlists, coupons, shipping-provider integration, multi-vendor.

Deliberately excluded from Phase 2, additive later: nested/tree categories and category deletion (§9.5), product name and text search (§8.3), image upload and object storage (§5.6), product slugs (§9.4), and inventory or stock fields and inventory reservation (Phase 3's problem).

---

## 2. Conflicts found before design

Per the brief, conflicts are surfaced, not silently resolved. Six were found; four changed the design, one is flagged and left with its existing owner, and one is a documentation tension. Each resolution below was a decision a reviewer could reject; the 2026-09-01 review accepted all of them.

### C1 — `prisma db seed` cannot run from the deployed image

**Severity: high — this decides D1.**

`Dockerfile`'s runtime stage runs `npm ci --omit=dev` and copies only `dist`, `node_modules/.prisma`, and `prisma/`. The `prisma` CLI and `ts-node` are both `devDependencies`, so **neither exists in the runtime image**. `docs/deferred-limitations.md` already records this for `prisma migrate deploy` ("The runtime image's Prisma setup is undeclared and untested", owner Phase 6).

A `prisma/seed.ts` bootstrap inherits that gap exactly. The required Definition of Done — *an operator can obtain an ADMIN from a fresh database using only documented commands* — would then hold only outside the deployed artifact, on a workstation or a CI runner with dev dependencies installed. That is a weaker guarantee than the DoD asks for, and it makes the bootstrap depend on an already-open Phase 6 limitation.

**Resolution:** the bootstrap is a **compiled script under `src/`**, not a Prisma seed. `tsconfig.build.json` excludes only `node_modules`, `test`, `dist`, and `**/*spec.ts`, so `src/scripts/bootstrap-admin.ts` compiles to `dist/scripts/bootstrap-admin.js` and runs in the runtime image as `node dist/scripts/bootstrap-admin.js` with **zero new dependencies**. See D1.

### C2 — a bootstrap script reading `process.env` would violate the config rule

`CLAUDE.md`: *"`src/config/` is the single place that reads `process.env`. Nothing else should call `process.env` directly."* The only sanctioned exception is `test/`, which must configure the environment before the app boots.

A standalone script reading `ADMIN_EMAIL`/`ADMIN_PASSWORD` off `process.env` would create a second exception and would bypass Joi validation entirely.

**Resolution:** the script boots a Nest **application context** (`NestFactory.createApplicationContext(AppModule)`) and reads configuration through `ConfigService`. The two variables are added to `configuration.ts`, `.env.example`, and the Joi schema in the same commit, per `CLAUDE.md` rule 2. No new exception to the config rule, and the script inherits fail-fast env validation.

### C3 — Phase 1 deliberately made `role` unreachable through `UsersService.create()`

`CreateUserInput` contains `email` and `passwordHash` and **no `role` field**. `AuthService.register()` passes no role. `auth.service.spec.ts` contains a test named *"never lets register set a role, so registration cannot create an ADMIN"*. This is a type-level security property, not a convention.

Adding `role?` to `CreateUserInput` to serve the bootstrap would weaken a tested Phase 1 invariant — and the brief forbids redesigning Phase 1.

**Resolution:** the bootstrap uses a **new, separate** method `UsersService.ensureAdmin()`. `CreateUserInput` is not touched, `register()` is not touched, and the existing test stays valid and meaningful. One narrow widening is required: `AuthModule` must add `PasswordHasherService` to its `exports` so the bootstrap hashes with the real Argon2id hasher rather than a second implementation (§4.3).

### C4 — foundation spec §7 assigns `RolesGuard` to Phase 1

Foundation spec §7 lists *"Authorization: `Role` enum enforced by `RolesGuard` with a `@Roles()` decorator"* inside the Phase 1 security model. Phase 1 spec §7 recorded a **deliberate deviation** deferring it to Phase 2, with the coupling condition that motivates §4 of this document.

**Resolution:** no live conflict. Phase 2 discharges the deviation. This spec records it so a future reader does not "correct" the foundation spec or conclude that Phase 1 shipped incomplete.

### C5 — flag only, not resolved here

A public `GET /products` becomes the busiest route in the API and inherits the default 100 req/min **per handler, per IP** limit. `docs/deferred-limitations.md` entry 1 (rate limiting keys on `req.ip`, no trusted-proxy configuration, owner **Phase 6**) therefore becomes more consequential in Phase 2 than it was in Phase 1.

**Phase 2 changes no throttler configuration and does not re-own that entry.** Whether to append one clarifying sentence to entry 1 was raised for review; §17.14 forbids closing or deleting entries and does not address annotating one, so the standing default is **do not touch the file at all**. The interaction is recorded here instead, and ownership stays Phase 6 (§16, still-open item 2).

### C6 — `CLAUDE.md` lists guards under `src/common/`, but `RolesGuard` goes in `modules/auth/`

`CLAUDE.md`: *"`src/common/` is for cross-cutting concerns only (filters, interceptors, guards, pipes)."* Read literally, a guard belongs in `common/`.

The same document then records the opposite outcome for the guard that already exists: *"the guard lives in `src/modules/auth/guards/` because it injects `TokenService` — putting it in `common/` would make the cross-cutting layer depend on a feature module."*

`RolesGuard` injects only `Reflector`, so the literal reason given for `JwtAuthGuard` does not apply to it. It does, however, type `request.user` as `AuthenticatedUser`, whose declaration — including the Express `Request` augmentation — lives in `src/modules/auth/types/`. That is a type-only dependency, but it is still `common/` pointing at a feature module.

**Resolution:** follow the `JwtAuthGuard` precedent and place `RolesGuard` in `src/modules/auth/guards/` (§6.2). The two guards are one mechanism — the second is meaningless without the first populating `request.user` — and separating them across layers would be harder to reason about than the rule's literal reading is worth. `@Roles()`, which is pure metadata with no such dependency, does go in `common/decorators/` beside `@Public()`. If a reviewer prefers the literal reading, the alternative is to declare a minimal local role-bearing type inside `common/` and duplicate it — which trades a documented placement for a duplicated type, and is not recommended.

---

## 3. Decisions at a glance

| # | Decision | Choice |
|---|---|---|
| **D1** | Admin bootstrap | Compiled, idempotent `bootstrap-admin` script run through a Nest application context. Seeds when absent, promotes when present. Ships in the **same task** as `RolesGuard`. |
| **D2** | Product ↔ Category | **One-to-many.** `Product.categoryId` required, `onDelete: Restrict`. |
| **D3** | Category identity | `name` unique **and** `slug` unique. Nested/tree categories **out of scope**. |
| **D4** | List contract | Offset pagination retained. Filters: `categoryId`, `minPriceCents`, `maxPriceCents` (+ admin `status`). Sort whitelist: `createdAt`, `priceCents`, `name`. Default `createdAt desc`. |
| **D5** | `isActive` filtering | Enforced in the service through a **required** `visibility` argument — omitting it is a compile error. Admins read inactive products through the admin controller only. |
| **D6** | Public routes | `GET /products`, `GET /products/:id`, `GET /categories` are `@Public()`. Nothing else. |
| **D7** | Deactivation | `DELETE /admin/products/:id` → 204, soft delete. Reactivation via `PATCH { isActive: true }`. |
| **D8** | Currency | `currency String @default("USD")` per product, ISO-4217 uppercase, validated. |
| **D9** | Image | `imageUrl String?` — a nullable URL field. No upload, no storage. |
| **D10** | Deferred limitations | Phase 2 closes **none**, and deletes none. It discharges the Phase 1 spec §11 "unproven primitives" note, which does not live in that file. |

All ten were **approved on 2026-09-01**. The review additionally settled the admin route structure, the guard chain, the pagination stance, and the bootstrap configuration rules; see §17.

---

## 4. D1 — Admin bootstrap (the entry condition)

### 4.1 The coupling requirement

> **`RolesGuard`, `@Roles()`, and the admin bootstrap ship as one indivisible implementation task.**

This is an entry condition, not a follow-up. Verified in the code: `UsersService.create()` accepts `{ email, passwordHash }`; `CreateUserInput` has no `role` field; `register()` passes no role; no other code path writes `role`. In a real deployment today, `ADMIN` is an unreachable value.

Shipping the guard alone produces:

- admin routes no real account can reach — a security control protecting nothing;
- a control exercisable only through `createUser(prisma, { role: Role.ADMIN })` in tests, i.e. proven in fixtures and unproven in production — the exact "correct by inspection, unproven in use" pattern that deferring the guard out of Phase 1 existed to avoid, and which this repository has already paid for twice (the never-built Dockerfile; `truncateAll()`'s race);
- a deployed API with no administrator, while a live deployment is a foundation spec §1 success criterion.

### 4.2 Definition of Done

> **An operator can obtain an ADMIN from a fresh database using only documented commands, with no test factory and no hand-edited rows.**

This sentence is the acceptance criterion for the task. "Documented commands" means commands present in `README.md` at the end of Phase 2. Hand-editing the database is independently forbidden by `CLAUDE.md`'s database conventions.

### 4.3 Chosen mechanism

A single script, `src/scripts/bootstrap-admin.ts`, that is **both** of the mechanisms the brief offered:

- when the address does not exist, it **creates** an `ADMIN` (the seed case);
- when the address exists, it **promotes** that user to `ADMIN` and leaves the password digest untouched (the promotion case).

Shape:

```
src/scripts/bootstrap-admin.ts     CLI wrapper: creates the application context, calls the function below, exits
src/scripts/bootstrap-admin.ts     exports bootstrapAdmin(deps) — the testable core, no process.exit, no console-only logic
```

Behaviour:

1. `NestFactory.createApplicationContext(AppModule)` — brings up `ConfigModule` (Joi validation), `PrismaModule`, `AuthModule`.
2. Read `admin.email` and `admin.password` through `ConfigService`. If either is absent or empty, **abort with a non-zero exit and a message naming the variable** — the same fail-fast posture as `requireEnv()` in `configuration.ts`.
3. Hash the password with the injected `PasswordHasherService` (real Argon2id, real parameters).
4. Call `UsersService.ensureAdmin({ email, passwordHash })`.
5. Log the outcome as one of `created` / `promoted` / `already an admin`. **Never log the password or the digest.**
6. Close the context; exit 0.

**Re-running is safe by construction.** A second run against a database the script has already bootstrapped takes the `already an admin` branch, performs **no write**, and exits 0. This is a required property, not an incidental one: the script is expected to sit in a release pipeline where it may run on every deploy, and it must be non-destructive on every run after the first. The three branches are exhaustive — absent, present-but-not-admin, already-admin — and none of them writes `passwordHash` for an existing row.

`UsersService.ensureAdmin({ email, passwordHash })`:

- user absent → create with `role: ADMIN` and the supplied digest;
- user present with `role: CUSTOMER` → set `role: ADMIN`, **do not touch `passwordHash`**;
- user present with `role: ADMIN` → no write.

Never overwriting an existing password is deliberate: a bootstrap command that silently resets a live account's credentials whenever an env var is set is a foot-gun and an escalation path. Promotion and password reset are different operations; Phase 2 ships only the first.

The method lives on `UsersService` because `UsersModule` owns the `User` model. `CreateUserInput` is untouched (C3).

### 4.4 Why this over the alternatives

| Option | Verdict |
|---|---|
| `prisma/seed.ts` via `prisma db seed` | **Rejected.** Requires the `prisma` CLI and `ts-node`, neither of which exists in the runtime image (C1). The DoD would hold only off-image, and the bootstrap would inherit an open Phase 6 limitation. |
| Standalone `ts-node` script | **Rejected.** Same dependency problem, plus it would read `process.env` directly (C2). |
| **Compiled script + application context** | **Chosen.** Runs in the deployed image (`node dist/scripts/bootstrap-admin.js`), adds no dependency, inherits Joi validation and DI, and reuses the real password hasher. |
| First registered user becomes `ADMIN` | **Rejected — explicitly.** A race on every fresh deployment: whoever registers first between migration and the operator's own registration becomes an administrator. It is also invisible in the code path a reader inspects (`register()` would gain a privilege branch that Phase 1 deliberately made impossible at the type level, undoing C3). Unacceptable as a bootstrap. |
| Admin-only promotion endpoint (`PATCH /users/:id/role`) | **Rejected as a standalone bootstrap.** It cannot bootstrap: creating the first admin through it requires an admin to already exist. It is a legitimate *later* feature on top of a working bootstrap, and is out of scope for Phase 2. |

### 4.5 Configuration

Added in the same commit to `src/config/configuration.ts`, `.env.example`, and `src/config/env.validation.ts`:

| Variable | Joi | Notes |
|---|---|---|
| `ADMIN_EMAIL` | `Joi.string().email().optional()` | Optional so the API boots without it. |
| `ADMIN_PASSWORD` | `Joi.string().min(8).max(128).optional()` | Bounds match `RegisterDto`. Optional for the same reason. |

Both are optional at the schema level and **required at script runtime**. The API never reads them on any request path.

`README.md` must document that these are bootstrap-only credentials, that the operator should change the password after first login, and that the variables can be removed from the environment afterwards.

### 4.6 Verification

Three layers, all required:

1. **Unit** — `bootstrapAdmin()` against a mocked `UsersService`: creates when absent, promotes when `CUSTOMER`, no-ops when already `ADMIN`, never rewrites `passwordHash`, aborts when either variable is missing.
2. **E2E** — an e2e spec imports the **real** `bootstrapAdmin()` core, runs it against the e2e database, then **logs in over HTTP with those credentials** and calls an admin-only route successfully. No `createUser` factory anywhere in that spec. This is the DoD expressed as a test.
3. **CI — required (approved 2026-09-01, §17.15).** A job that executes the built artifact, `node dist/scripts/bootstrap-admin.js`, against a fresh database. This is the only layer that proves the *compiled, shipped* command works, as opposed to the function it wraps.

#### 4.6.1 The CI bootstrap verification contract

Phase 2 **may** modify `.github/workflows/ci.yml` for this and for nothing else. The job must:

1. **Build the application** (`npm ci`, `npm run prisma:generate`, `npm run build`) so the artifact under test is the compiled `dist/` output, not TypeScript sources.
2. Use a **fresh PostgreSQL database** — a service container with migrations applied by `prisma migrate deploy`, with no rows carried over from another job.
3. Run **exactly** `node dist/scripts/bootstrap-admin.js` — the same command `README.md` gives an operator. If the two ever diverge, the test is worthless; the workflow must not invent a variant invocation, add flags, or call the source through `ts-node`.
4. Supply `ADMIN_EMAIL` and `ADMIN_PASSWORD` as CI-provided environment values, alongside the `DATABASE_URL` and `JWT_SECRET` the application context needs to boot.
5. **Assert an `ADMIN` row exists afterward** — a user with the configured email and `role = 'ADMIN'`.
6. **Run the bootstrap a second time** and assert it is idempotent: the command exits 0, the row count for that email is still one, the role is still `ADMIN`, and **`password_hash` is byte-identical to its value after the first run**. Capturing the digest between the two runs and comparing is the assertion that actually pins the never-overwrite-a-password rule; asserting only "exit 0" would pass against a script that silently reset the credential.
7. Make **no unrelated CI changes** — no touching the existing `build`, `e2e`, or `docker` jobs, no version bumps, no caching changes, no reordering.

**What this proves, and what it deliberately does not.** It proves the compiled command works against a real database using the documented invocation. It does **not** run the command inside the Docker runtime image, so it does not close `docs/deferred-limitations.md` entry 5 ("The runtime image's Prisma setup is undeclared and untested"), which also covers `prisma migrate deploy` and the fact that CI builds the image without ever running it. That entry stays open and owned by Phase 6, per §17.14. Claiming otherwise would be the precise error that entry warns about.

---

## 5. Data model

### 5.1 Category

```prisma
model Category {
  id        String    @id @default(uuid(7))
  name      String    @unique
  slug      String    @unique
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  products  Product[]

  @@map("categories")
}
```

### 5.2 Product

```prisma
model Product {
  id          String   @id @default(uuid(7))
  name        String
  description String
  priceCents  Int      @map("price_cents")
  currency    String   @default("USD")
  imageUrl    String?  @map("image_url")
  isActive    Boolean  @default(true) @map("is_active")
  categoryId  String   @map("category_id")
  category    Category @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@index([categoryId])
  @@index([isActive, createdAt])
  @@map("products")
}
```

Conventions honoured: UUID v7 primary keys, `createdAt`/`updatedAt` on both models, PascalCase singular models with camelCase fields, snake_case plural tables via `@@map`/`@map`.

### 5.3 Relationships and indexes — D2

**One-to-many.** `Product.categoryId` is required; a product belongs to exactly one category.

Rationale: the roadmap explicitly excludes multi-vendor and every catalog operation Phases 2–4 need is expressible with a single category per product. One-to-many gives a real foreign key — the first in the project after `RefreshToken.userId` — which is what finally exercises the `P2003` mapping that has been unit-tested and never triggered. Many-to-many would add a join table and a second write path for no capability any phase requires. The migration to many-to-many, if ever needed, is additive; **reversing it after Phase 3's orders reference products would not be**, which is why this is decided now rather than left open.

`onDelete: Restrict`, deliberately **not** `Cascade`. Deleting a category must never silently delete its products. With `Restrict`, an attempted delete raises `P2003`, which `HttpExceptionFilter` already maps to 409. Category deletion is not shipped in Phase 2 (§9.5), so `Restrict` is also the safe default for a route that does not yet exist.

Indexes:

- `@@index([categoryId])` — category filtering and FK maintenance.
- `@@index([isActive, createdAt])` — the default public list is `WHERE is_active = true ORDER BY created_at DESC`, and this index serves both halves.
- No index for `priceCents` or `name` sorting. Both are non-default sorts over a catalog with no size problem yet; adding an index for an unmeasured query is speculation. Noted here so a future phase adds them against evidence.

### 5.4 Money — D8

`priceCents Int` plus `currency String @default("USD")`. Integer minor units, exactly as foundation spec §6 requires. **No floating-point money anywhere**: not in the schema, not in DTOs, not in Swagger examples, not in test fixtures.

`currency` is a per-product ISO-4217 alphabetic code, stored uppercase, validated on write with `@Length(3, 3)` and `@IsUppercase()`. The API is single-currency in practice; the column exists because retrofitting a currency onto persisted money is a data migration, and because Phase 4's payment provider expects both values at its boundary with no conversion.

`priceCents` is validated as `@IsInt() @Min(0)`. Because the global pipe sets `enableImplicitConversion: false`, every numeric DTO field carries an explicit `@Type(() => Number)`.

### 5.6 Product image — D9

`imageUrl String?` — a single nullable column, validated on write with `@IsUrl()` and `@MaxLength(2048)`, omitted or `null` when absent.

No upload endpoint, no multipart handling, no object storage, no image processing, no secondary images table. Storing a URL costs one column and makes the Swagger demo look like a real catalog; accepting an upload drags in a storage backend, a size and content-type policy, and a signed-URL story, none of which any phase before deployment requires. If image hosting is ever added, this column is what it populates.

### 5.5 Deactivation semantics

`Product.isActive` is the only soft delete in the project, and stays that way. There is no global soft-delete mechanism and none is introduced.

Rationale (foundation spec §6): historical orders in Phase 3 must keep valid product references. A hard delete would break that; `isActive` preserves the row and removes the product from the catalog.

`Category` has **no** `isActive` field. Categories are not ordered against, so no history depends on them, and adding a lifecycle flag no route consumes would be speculative.

---

## 6. Authorization

### 6.1 `@Roles()` placement — requirement 9

`src/common/decorators/roles.decorator.ts`, beside `public.decorator.ts`.

It is pure metadata (`SetMetadata`) with no injected dependency, and `CLAUDE.md` designates `src/common/` for cross-cutting concerns. It imports `Role` from `@prisma/client`, which is generated-client territory rather than a feature module, so `common/` acquires no dependency on `modules/`.

```
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]): CustomDecorator => SetMetadata(ROLES_KEY, roles);
```

### 6.2 `RolesGuard` placement and behaviour — requirement 8

`src/modules/auth/guards/roles.guard.ts`, beside `jwt-auth.guard.ts`.

It consumes `AuthenticatedUser` from `src/modules/auth/types/`, and it is meaningless without the guard that populates `request.user`. Placing it in `common/` would make the cross-cutting layer depend on a feature module — the exact inversion Phase 1 avoided by splitting `@Public()` from `JwtAuthGuard`. `AuthModule` provides and exports it, mirroring `JwtAuthGuard`.

Behaviour, in order:

1. Read `@Roles()` metadata with `reflector.getAllAndOverride(ROLES_KEY, [handler, class])`.
2. **No metadata, or an empty list → allow.** Authorization is opt-in.
3. Metadata present and `request.user` undefined → **deny with 403**. This is only reachable if a route carries both `@Public()` and `@Roles()`, which is a configuration error; the guard denies rather than throwing, and a unit test pins the behaviour.
4. `request.user.role` in the required list → allow. Otherwise → **403 Forbidden**.

**The opt-in default is the one asymmetry in the guard chain and it is deliberate.** `JwtAuthGuard` fails closed because *authentication* has a safe universal default (require it). Authorization does not: a fail-closed `RolesGuard` would have to invent a required role for every route, including the public catalog. The residual risk — a write route that forgets `@Roles()` is reachable by any authenticated `CUSTOMER` — is mitigated structurally in §7.2 and by test coverage in §11.

The guard performs **no database query**. It reads `role` from the verified access token, which is why Phase 1 kept `role` in the JWT payload. A role change therefore takes effect for a given session when its access token expires (≤15 minutes) or on refresh. This is accepted; documenting it here prevents a later reader from "fixing" it with a per-request user lookup on every guarded route.

### 6.3 Guard ordering — requirement 10

`AppModule` registers, in this order:

```
ThrottlerGuard  →  JwtAuthGuard  →  RolesGuard
```

Global guards run in registration order. The rationale is cumulative: an unauthenticated flood is rejected before any token verification or database work (Phase 1's rule, unchanged), and role evaluation happens only after `request.user` exists. `RolesGuard` is registered exactly as `JwtAuthGuard` is — provided under its own class token by `AuthModule`, aliased into `APP_GUARD` with `useExisting` — so `overrideProvider()` can target it in tests. `JwtAuthGuard`'s behaviour is not modified in any way.

### 6.4 Authorization matrix — requirement 11

| Caller | Public catalog read | Admin route |
|---|---|---|
| No token | 200 | **401** |
| Expired/invalid token | 200 | **401** |
| Valid token, `CUSTOMER` | 200 | **403** |
| Valid token, `ADMIN` | 200 | **2xx** |

401 comes from `JwtAuthGuard`, 403 from `RolesGuard`, both shaped by `HttpExceptionFilter` into the standard error body. The distinction is intentional and is asserted per route in e2e (§11).

---

## 7. API surface

### 7.1 Public catalog — D6

Exactly three routes are `@Public()`:

| Route | Success | Notes |
|---|---|---|
| `GET /api/v1/products` | 200 | Paginated, filtered, sorted. **Active products only.** |
| `GET /api/v1/products/:id` | 200 | Active only; inactive or unknown id → **404**. |
| `GET /api/v1/categories` | 200 | Paginated with the same `page`/`limit` contract, `{ data, meta }`. |

A catalog behind a login is not a store catalog, and the brief's default stands: no concrete reason to protect reads was found. Consequences accepted and recorded: `GET /products` becomes the highest-traffic route in the API and inherits the 100 req/min per-handler-per-IP default, which interacts with deferred entry 1 (C5).

Categories are returned as a paginated collection for shape consistency with `PaginatedDto`, using the same `PaginationQueryDto`. Category counts are small; this costs nothing and avoids a second collection convention.

### 7.2 Admin catalog

All admin operations live on a **separate controller** with a class-level `@Roles(Role.ADMIN)`:

| Route | Success | Notes |
|---|---|---|
| `GET /api/v1/admin/products` | 200 | Same contract as the public list **plus** `status=active\|inactive\|all` (default `all`). |
| `POST /api/v1/admin/products` | 201 | Unknown `categoryId` → 409 (`P2003`). |
| `PATCH /api/v1/admin/products/:id` | 200 | Partial update, including `isActive`. Unknown id → 404 (`P2025`). |
| `DELETE /api/v1/admin/products/:id` | 204 | Soft delete (§7.3). |
| `POST /api/v1/admin/categories` | 201 | Duplicate `name` or `slug` → 409 (`P2002`). |
| `PATCH /api/v1/admin/categories/:id` | 200 | Unknown id → 404. |

**Approved 2026-09-01 (§17.11).** The review confirmed the public catalog stays at `/api/v1/products` and `/api/v1/categories`, and that admin writes use `POST`, `PATCH`, and `DELETE` under `/api/v1/admin/products` with class-level ADMIN authorization.

**Reconciliation — `GET /api/v1/admin/products` remains.** The approved list in §17.11 enumerates the *write* operations. The admin **list** route is retained under §17.5, which requires that "admin reads can explicitly request inactive products"; there is no other route through which an administrator can see an inactive product, since the public list excludes it and the public detail route 404s on it. It sits on the same controller and inherits the same class-level `@Roles(Role.ADMIN)`. Should a reviewer intend the admin surface to be write-only, §17.5 cannot be satisfied and the two decisions need reconciling before task 7 — flagged rather than assumed.

**Why a separate controller and an `/admin` path segment — originally a deviation from the Phase 2 audit, which illustrated writes at `POST /api/v1/products`.**

Two reasons, one structural and one mechanical:

- *Structural:* the highest-likelihood authorization defect in this phase is a write route that forgets `@Roles()`. On a mixed controller that is a per-method decorator that must be remembered six times; on a split controller it is one class-level decorator, and every route in the file inherits it. The failure mode is reduced from "six chances to forget" to "one".
- *Mechanical:* an admin-visible listing cannot live on the public route. `JwtAuthGuard` returns `true` immediately for a `@Public()` route and **never parses the token**, so `request.user` is `undefined` there even when a valid admin token is sent. A "public but elevated for admins" variant of `GET /products` would require changing `JwtAuthGuard` to optionally decode tokens — which the brief forbids and which would weaken a Phase 1 invariant.

The cost is a slightly less canonical URL for writes. This was the deviation most worth a second opinion; the review took it and approved it.

Admin reads exist because without them deactivation is a one-way door: a deactivated product is absent from the public list and 404s on the public detail route, so its id becomes unrecoverable through the API. A single admin list with a `status` filter closes that at minimal cost. A separate admin *detail* route is not shipped — `PATCH` returns the full entity, which covers the reactivation flow.

### 7.3 Deactivation — D7

`DELETE /api/v1/admin/products/:id` performs a **soft delete**: it sets `isActive = false` and returns 204. It never removes the row.

Reactivation is `PATCH /api/v1/admin/products/:id` with `{ "isActive": true }`.

The overlap is acknowledged: `DELETE` is equivalent to `PATCH { isActive: false }`. `DELETE` is kept as the conventional entry point for "remove this from the catalog" and its soft-delete semantics are documented in its `@ApiOperation`; `PATCH` is the general field editor. The alternative — an action route such as `POST /products/:id/activate` — introduces a non-resource verb into a REST-conventional API to avoid a harmless overlap, and is rejected.

`DELETE` on an already-inactive product returns 204 (idempotent). `DELETE` on an unknown id returns 404.

### 7.4 Response DTOs

Every response is an explicit DTO with a static `from()` mapper, following `UserResponseDto`. **No object spread, no `plainToInstance`, no returning Prisma objects.** `@Exclude()` silently does nothing on Prisma's plain objects, so explicit field-by-field mapping is the only mechanism that actually prevents leaks.

- `CategoryResponseDto` — `id`, `name`, `slug`, `createdAt`.
- `ProductResponseDto` — `id`, `name`, `description`, `priceCents`, `currency`, `imageUrl`, `isActive`, `categoryId`, `createdAt`, and `category: CategoryResponseDto`.

The nested category is **always** included, on both the list and the detail route, and the service always queries it with a Prisma `include`. There is no `?include=` parameter and no variant shape. One join against an indexed foreign key is cheaper than forcing every client into a second request per product, and a response DTO whose shape depends on a query parameter is two contracts wearing one name.

`isActive` is exposed on the public DTO even though the public list only ever contains active products. It is not sensitive, it is meaningful on admin responses, and one DTO shared by both surfaces is simpler than two that differ by one field.

Single resources are returned bare; collections are wrapped as `{ data, meta }` via `PaginatedDto` (foundation spec §5).

---

## 8. List contract — D4

### 8.1 Pagination

**Offset pagination is retained.** Foundation spec §5 chose page/limit deliberately; the catalog has no size problem, and page numbers are far easier to exercise from Swagger UI. Switching to cursor pagination would amend foundation spec §5 and is explicitly not proposed.

### 8.2 Fit assessment of the `common/` primitives

Phase 1 spec §11 instructed Phase 2 to *reshape the DTO, not the endpoint* when the pagination primitives meet their first real consumer, noting the cost of change is zero now and will never be lower. That assessment was performed:

| Primitive | Verdict |
|---|---|
| `PaginationQueryDto` (`page`, `limit`, `skip`) | **Fits unchanged.** `ProductListQueryDto extends PaginationQueryDto` adds filters and sort as new properties. `whitelist`/`forbidNonWhitelisted` work correctly across inheritance. |
| `PaginatedDto<T>` + `PaginationMetaDto` | **Fits unchanged.** `from(data, total, query)` takes exactly what the service produces. |
| `@ApiPaginatedResponse(Model)` | **Fits unchanged.** Composes the schema for `ProductResponseDto` and `CategoryResponseDto` as written. |

**Conclusion: no reshape is required, and none should be made.** This is the documented outcome the Phase 1 instruction asked for — an explicit evaluation, not silence. If implementation discovers a misfit, changing the primitive remains the correct response and must be recorded in the plan rather than worked around at the endpoint.

### 8.3 Filters

`ProductListQueryDto` (public):

| Field | Type | Validation |
|---|---|---|
| `page`, `limit` | inherited | 1-based; `limit` 1–100, default 20 |
| `categoryId` | string | `@IsUUID()`, optional |
| `minPriceCents` | number | `@Type(() => Number) @IsInt() @Min(0)`, optional |
| `maxPriceCents` | number | `@Type(() => Number) @IsInt() @Min(0)`, optional |
| `sort` | enum | `createdAt \| priceCents \| name`, default `createdAt` |
| `order` | enum | `asc \| desc`, default `desc` |

`AdminProductListQueryDto extends ProductListQueryDto` adds:

| Field | Type | Validation |
|---|---|---|
| `status` | enum | `active \| inactive \| all`, default `all` |

If both price bounds are supplied and `minPriceCents > maxPriceCents`, the endpoint returns an empty page rather than a 400. The range is satisfiable-but-empty, not malformed, and 400 would be the wrong signal.

**No name/text filter in Phase 2.** An unindexed `contains` scan is exactly the kind of feature that looks free and is not; "advanced search" is on the excluded list, and adding a filter later is additive while removing one is a breaking API change. Full-text search, if ever wanted, is a separate decision with its own index.

### 8.4 Sorting and the whitelist

Sortable fields are **`createdAt`, `priceCents`, `name`** — nothing else. The whitelist is enforced by a TypeScript enum plus `@IsEnum()` in the DTO, so an invalid value is rejected by the global `ValidationPipe` with a 400 and **never reaches Prisma**. Free-form sort strings passed into an ORM are an injection-shaped surface and an unbounded index problem; the enum makes the invalid case unrepresentable.

Default order is `createdAt desc` — newest first, and it is the ordering the `[isActive, createdAt]` index serves.

Ordering is not guaranteed stable across pages when sorting by a non-unique column (`name`, `priceCents`). Phase 2 accepts this; a secondary `id` tiebreaker is the fix if it ever matters, and is noted here rather than added speculatively.

---

## 9. Service layer

### 9.1 Modules

Two modules, mirroring the `users`/`auth` split:

```
src/modules/categories/    CategoriesService, CategoriesController, AdminCategoriesController, DTOs
src/modules/products/      ProductsService, ProductsController, AdminProductsController, DTOs
```

`ProductsModule` does **not** import `CategoriesModule`. It has no need to: the foreign key enforces category existence, and a violation surfaces as `P2003` → 409 through the existing filter. Adding a service call to pre-check the category would duplicate a database guarantee and introduce a check-then-act race.

Controllers stay thin — validate via DTO, delegate to the service, shape the response. Services own their Prisma queries; there is no repository layer.

### 9.2 `isActive` enforcement — D5

Visibility is a **required argument** on every read method:

```
type ProductVisibility = 'active-only' | 'all' | 'inactive-only';

list(query: ProductListQuery, visibility: ProductVisibility): Promise<{ items: Product[]; total: number }>
findOne(id: string, visibility: ProductVisibility): Promise<Product>
```

- `ProductsController` (public) always passes `'active-only'`.
- `AdminProductsController` maps its `status` filter onto the visibility argument.

Making it a required parameter rather than an optional flag with a safe default is the point: a caller that omits it **fails to compile**, and the union type means a caller that supplies the wrong value fails too. A default of `'active-only'` would be safe but silent, and the failure mode this guards against — a new caller in Phase 3 quietly reading inactive products into an order — is precisely the kind a default hides. The rule is the same one Phase 1 applied when it left `role` off `CreateUserInput`: make the unsafe call unrepresentable rather than merely discouraged.

Rejected alternatives: per-call `where` clauses assembled by each caller (the leak waiting to happen), and a Prisma middleware/client extension applying a global filter (invisible action-at-a-distance that would surprise Phase 3's checkout).

The public **detail** route enforces the same rule: an inactive product returns 404, not 200. Enforcing on the list but not the detail route is the specific defect this design is written to prevent.

### 9.3 Error mapping

No new mapping is added to `HttpExceptionFilter`. Phase 2 is the first real consumer of what is already there:

| Condition | Prisma | HTTP |
|---|---|---|
| Duplicate category `name`/`slug` | `P2002` | 409 |
| Product references an unknown category | `P2003` | 409 |
| Update/delete an unknown id | `P2025` | 404 |

`P2003` reaching the filter from a real HTTP request for the first time is a Phase 2 milestone (Phase 1 spec §11), and §11 requires a test for it.

### 9.4 Slug handling — D3

`Category.name` and `Category.slug` are **both** unique.

`slug` is client-supplied on create and validated with `@Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)`. It is not derived from the name: automatic slugification needs a transliteration policy and a collision strategy, both of which are invisible complexity for a field an operator can simply type. Uniqueness on both columns gives two distinct `P2002` paths and a stable public identifier for future URL work.

Products have **no slug** in Phase 2. Nothing routes by product slug; adding one later is additive.

### 9.5 Nested categories and category deletion — D3

**Nested/tree categories are out of scope.** No `parentId`, no closure table, no materialised path. No phase in the roadmap requires hierarchy, and a self-referencing tree brings ordering, depth limits, cycle prevention, and recursive queries with it. A flat list is what the catalog needs.

**Category deletion is not shipped in Phase 2.** A delete route needs an orphan policy — reject when products reference it, cascade-deactivate them, or reassign to a default category — and each is a product decision, not a technical default. `onDelete: Restrict` means that when the route does arrive, the safe behaviour (409) is already the database's answer. This is a scope decision, not an accepted limitation, so it adds no entry to `docs/deferred-limitations.md`.

---

## 10. Documentation expectations — requirement 14

Every endpoint carries `@ApiTags`, `@ApiOperation`, and `@ApiResponse` for each status it can return, per `CLAUDE.md`.

- Tags: `products`, `categories`, `admin-products`, `admin-categories`.
- Every admin route carries `@ApiBearerAuth()` and documents **both** 401 and 403 as distinct responses. Documenting only one of them hides half the authorization contract.
- List endpoints use `@ApiPaginatedResponse(Model)`.
- `DELETE /admin/products/:id` states in its `@ApiOperation` that it is a soft delete and that the product remains retrievable by an administrator.
- Query parameters document their defaults and, for `sort`/`order`/`status`, their full enum.
- Money examples in Swagger are integers (`4999`), never decimals.

`README.md` gains the new routes in the existing table, the bootstrap command with its two environment variables, and the current-phase line moved to Phase 3.

`CLAUDE.md` gains a Phase 2 section recording the non-obvious invariants: the `RolesGuard` opt-in default and why it differs from `JwtAuthGuard`, the required `visibility` argument, the sort whitelist, `onDelete: Restrict`, and the bootstrap's never-overwrite-a-password rule.

---

## 11. Test strategy — requirement 15

### 11.1 Unit

| Target | Coverage |
|---|---|
| `RolesGuard` | ADMIN allowed; CUSTOMER denied with 403; no metadata → allowed; metadata present with `request.user` undefined → denied; class-level metadata honoured. |
| `ProductsService` | Pagination arithmetic; each filter; each whitelisted sort; `visibility` translation into the `where` clause for all three values; not-found handling. |
| `CategoriesService` | Create, update, list; duplicate handling delegated to the filter. |
| `bootstrapAdmin()` | Creates, promotes, no-ops; never rewrites `passwordHash`; aborts on missing configuration. |

`PrismaService` is mocked throughout, per `CLAUDE.md`.

### 11.2 E2E

Against the real dockerised Postgres on 5433, serial, using `createTestApp()` and `truncateAll()`.

**Authorization matrix — asserted per write route, not once representatively:**

for each of `POST /admin/products`, `PATCH /admin/products/:id`, `DELETE /admin/products/:id`, `POST /admin/categories`, `PATCH /admin/categories/:id`, `GET /admin/products`:

- no token → 401
- valid `CUSTOMER` token → 403
- valid `ADMIN` token → 2xx

**Catalog behaviour:**

- pagination `meta` correctness (`page`, `limit`, `total`, `totalPages`) across at least two pages;
- `limit` above 100 → 400;
- each filter narrows the result set as specified;
- each whitelisted sort orders correctly; an unlisted sort value → 400;
- an inactive product is absent from `GET /products` **and** 404s on `GET /products/:id`;
- the same inactive product **is** visible via `GET /admin/products?status=inactive`;
- unknown product id → 404 (first real `P2025` from a request);
- duplicate category `name` and duplicate `slug` → 409 (`P2002`);
- product created with an unknown `categoryId` → 409 (**first real `P2003` from a request**);
- `DELETE` then `GET /products/:id` → 404, then `PATCH { isActive: true }` restores it to the public list.

**Bootstrap:** as specified in §4.6 — the real `bootstrapAdmin()`, then an HTTP login, then an admin-only call. No user factory in that spec.

### 11.3 Harness rules carried forward

- `maxWorkers: 1` stays. `truncateAll()`'s read-then-truncate race is unfixed and the new tables do not change that. Product and category factories must not reintroduce cross-worker assumptions.
- Factories insert through the Prisma client, never `$executeRaw` — `uuid(7)` is generated client-side and a raw insert produces a row with no id.
- Any suite issuing heavy traffic passes `{ throttleLimit }` to `createTestApp()`. It is a boolean trigger, not a numeric cap. An unexplained 429 in a catalog suite is this.
- Suites with fixed identifiers call `truncateAll()` in `beforeEach`; the e2e database persists between runs.
- Use `overrideProvider()`, never `overrideGuard()`, for `APP_GUARD`-registered guards — including the new `RolesGuard`.

### 11.4 Gate

`npm run lint`, `npm run build`, `npm test`, and — since everything here is database-dependent — `npm run test:e2e`, all green.

---

## 12. Task dependency order — requirement 16

| # | Task | Depends on | Gate |
|---|---|---|---|
| **1** | `Category` + `Product` models and migration | — | Migration replays clean from an empty database in CI |
| **2** | **`@Roles()` + `RolesGuard` + admin bootstrap + `ensureAdmin()` + config/env + `AuthModule` exports `PasswordHasherService` + the §4.6.1 CI verification job** — one commit | 1 | All three §4.6 layers green: guard unit tests, the e2e DoD test, and the CI job running the compiled artifact twice; guard order asserted |
| **3** | Category and product test factories | 1 | Consumed by tasks 4–9 |
| **4** | `CategoriesService` + unit tests | 1, 3 | `npm test` |
| **5** | `ProductsService` + unit tests | 1, 3 | `npm test` |
| **6** | Public read routes + DTOs + Swagger | 5 | e2e smoke |
| **7** | Admin routes (writes + admin list) | 2, 5, 6 | Authorization matrix e2e |
| **8** | Pagination fit confirmation, or a documented reshape | 6 | §8.2 outcome recorded in the plan |
| **9** | Full catalog + authorization e2e | 6, 7 | `npm run test:e2e` |
| **10** | `CLAUDE.md`, `README.md` | all | Review |

Hard orderings, restated because they are the ones that break silently:

- **Task 2 is indivisible.** The guard, the bootstrap, and the §4.6.1 CI job are one commit. Splitting the first two produces the failure described in §4.1; landing the CI job separately means the artifact ships unverified in the interval, which is the gap §17.15 exists to close.
- **Task 7 cannot precede task 2.** Admin routes without a reachable admin role are untestable in production terms.
- **Task 8 follows task 6.** Reshaping a shared primitive before a real query exists repeats the mistake that produced the unproven primitives in the first place.
- Task 1 precedes everything; the migration must exist before any code depends on the models.

---

## 13. Constraint compliance

| Constraint | How this design honours it |
|---|---|
| No Redis/BullMQ | None referenced. Catalog caching stays Phase 5. |
| Don't change `JwtAuthGuard` | Untouched. §7.2 documents the one design pressure that would have required changing it, and routes around it instead. |
| Don't redesign Phase 1 | `CreateUserInput`, `register()`, rotation, throttling, and the filter are untouched. One additive export (`PasswordHasherService`) and one new `UsersService` method. |
| Don't touch unrelated deferred entries | No entry is edited. The one related entry is flagged in C5 and left in §16 as a question. |
| No `RolesGuard` without a bootstrap | §4, task 2, and the DoD. |
| Public product reads | D6. |
| Consistent module boundaries | Two feature modules; controllers thin; services own queries; `common/` gains only a metadata decorator. |
| Explicit DTO mappers | §7.4 — static `from()`, no spread. |
| Integer money | §5.4 — no floating point anywhere, including Swagger examples. |
| Pagination reshape allowed but explicit | §8.2 — evaluated, documented, conclusion "no change required". |
| No speculative features | §1 out-of-scope list; each exclusion carries a reason and a note that it is additive later. |

---

## 14. Deferred limitations — D10

**Phase 2 closes no entry in `docs/deferred-limitations.md`.** All six open entries are owned by Phase 5, Phase 6, unscheduled, or accepted by design, and none is in this phase's path.

What Phase 2 *does* discharge is the Phase 1 spec §11 note that `PaginationQueryDto`, `PaginatedDto`, `@ApiPaginatedResponse`, and the `P2003` mapping were unproven. That note lives in the Phase 1 spec, not in the limitations file, so no file entry changes.

**Phase 2 adds no new entry.** Category deletion, product search, product slugs, and stable cross-page ordering for non-unique sorts are scope decisions with recorded reasoning, not accepted limitations. If implementation defers something genuinely new, it must be added to that file — and no entry may ever be closed by deleting it.

---

## 15. Definition of Done for Phase 2

1. `Category` and `Product` exist with one committed migration that replays from empty in CI.
2. The three public read routes behave as §7.1 specifies, including the inactive-product 404 on the detail route.
3. All admin routes enforce the §6.4 matrix, asserted per route in e2e.
4. **An operator can obtain an ADMIN from a fresh database using only documented commands, with no test factory and no hand-edited rows.**
5. **The CI job of §4.6.1 runs `node dist/scripts/bootstrap-admin.js` twice against a fresh database and passes**, including the byte-identical `password_hash` assertion on the second run.
6. `RolesGuard`, `@Roles()`, the bootstrap, and that CI job were delivered in a single commit.
7. Guard order is `ThrottlerGuard → JwtAuthGuard → RolesGuard`, asserted by test.
8. The pagination fit assessment is recorded, and any change to a `common/` primitive is explicit and documented.
9. `P2002`, `P2003`, and `P2025` are each triggered by a real HTTP request in e2e.
10. Swagger documents every route, both 401 and 403 on admin routes, and integer money.
11. `npm run lint`, `npm run build`, `npm test`, `npm run test:e2e` all pass.
12. `CLAUDE.md` and `README.md` updated; no deferred-limitations entry deleted.

---

## 16. Open questions

### Closed by the 2026-09-01 review

| Was | Outcome |
|---|---|
| `/api/v1/admin/*` for writes | **Approved** (§17.11). Public catalog stays at `/api/v1/products` and `/api/v1/categories`; admin writes are `POST`/`PATCH`/`DELETE` under `/api/v1/admin/products` with class-level ADMIN authorization. |
| Client-supplied category `slug` | **Approved** (§17.3). Slug is client-supplied and validated; no auto-slugification. |
| `ADMIN_PASSWORD` reachable via `ConfigService` | **Approved** (§17.13). Both variables are read through `ConfigService` and are optional, so normal boot never requires them. The `CLAUDE.md` config rule stays intact. |
| May Phase 2 modify `.github/workflows/ci.yml`? | **Approved, narrowly** (§17.15). Permitted **solely** to verify the compiled bootstrap artifact, under the seven-point contract in §4.6.1. No unrelated CI change. |

### Still open — none blocks the implementation plan

1. **No admin product *detail* route (§7.2).** Not raised by the review. The decision stands: `PATCH` returns the full entity and `GET /api/v1/admin/products?status=inactive` locates inactive products, so the reactivation flow is complete without it. Adding it later is additive and breaks nothing.
2. **Whether to append one sentence to deferred entry 1 (C5)** noting that a public catalog raises the trusted-proxy exposure. §17.14 forbids closing or deleting entries; it does not address annotating one. **Default: do not touch it.** The interaction is recorded in C5 of this spec instead, and ownership stays Phase 6.

---

## 17. Review outcome — authoritative decisions (2026-09-01)

The design was approved with clarifications, in two rounds on 2026-09-01: fourteen decisions in the first, and the CI bootstrap verification (17.15) in the second. All fifteen are **authoritative**: where any earlier section of this document could be read as saying something different, this section governs, and the earlier section is a defect to be corrected rather than an alternative to be weighed.

| # | Decision | Recorded in |
|---|---|---|
| **17.1** | **D1 — admin bootstrap.** Compiled, idempotent script under `src/scripts/`, run through a Nest application context, reading configuration through `ConfigService`. It creates the ADMIN when the configured email does not exist; promotes an existing user to ADMIN when appropriate; **never overwrites an existing user's password**; is runnable against a fresh database using documented commands; and satisfies the exact bootstrap DoD with no test factory and no hand-edited rows. | §4 |
| **17.2** | **D2 — cardinality.** Product → Category is one-to-many. `Product.categoryId` is required. Category deletion must **not** cascade-delete products; restrictive semantics (`onDelete: Restrict`). | §5.2, §5.3 |
| **17.3** | **D3 — category identity.** `name` and `slug` are both unique. Slug is client-supplied and validated. Nested/tree categories are out of scope. | §5.1, §9.4, §9.5 |
| **17.4** | **D4 — list contract.** Offset pagination retained. Explicit query DTOs. Sort fields whitelisted; **no free-form Prisma sorting**. No text search in Phase 2. Filters are `categoryId`, `minPriceCents`, `maxPriceCents`, plus explicit admin-only `status` handling. | §8 |
| **17.5** | **D5 — visibility.** Enforced by the service API. Public reads explicitly request active-only visibility. **Admin reads can explicitly request inactive products.** The public product detail route returns **404** for an inactive product. | §9.2, §7.1, §7.2 |
| **17.6** | **D6 — public routes.** Exactly `GET /api/v1/products`, `GET /api/v1/products/:id`, and `GET /api/v1/categories` are `@Public()`. | §7.1 |
| **17.7** | **D7 — deactivation.** `DELETE /api/v1/admin/products/:id` performs soft deactivation (`isActive = false`). Reactivation happens through `PATCH` with `isActive: true`. | §7.3 |
| **17.8** | **D8 — money.** `priceCents` as `Int`; `currency` as `String` defaulting to `USD`, validated as uppercase ISO-4217. **Never floating-point prices.** | §5.4 |
| **17.9** | **D9 — image.** Product has a nullable `imageUrl`. No upload, no object storage, no image processing. | §5.6 |
| **17.10** | **`RolesGuard` is opt-in.** No `@Roles()` metadata → allow; `@Roles(...)` → enforce the required role. Admin product write controllers use **class-level** `@Roles(Role.ADMIN)` to reduce omission risk. Guard chain is `ThrottlerGuard → JwtAuthGuard → RolesGuard`. | §6.2, §6.3, §7.2 |
| **17.11** | **Admin API structure.** Public catalog remains under `/api/v1/products` and `/api/v1/categories`. Admin write operations are `POST /api/v1/admin/products`, `PATCH /api/v1/admin/products/:id`, `DELETE /api/v1/admin/products/:id`, with class-level ADMIN authorization. (The admin **list** route is retained under 17.5; see the reconciliation note in §7.2.) | §7.2 |
| **17.12** | **Pagination.** Do not reshape the shared primitives speculatively. Use `ProductListQueryDto` on top of the existing primitives. Change the `common/` pagination DTOs **only** if the real product list contract proves a concrete need, and make that change explicit. | §8.2, task 8 |
| **17.13** | **Bootstrap configuration.** `ADMIN_EMAIL` and `ADMIN_PASSWORD` are read through `ConfigService` and are **optional** environment variables, so normal application boot does not require bootstrap credentials. If the bootstrap runs twice, the second run must be safe and non-destructive. | §4.3, §4.5 |
| **17.14** | **Deferred limitations.** Phase 2 must not close or delete existing entries in `docs/deferred-limitations.md`. | §14 |
| **17.15** | **CI bootstrap verification (added 2026-09-01).** Phase 2 **may** modify `.github/workflows/ci.yml` **solely** to verify the compiled admin-bootstrap artifact. The job must build the application, use a fresh PostgreSQL test database, run `node dist/scripts/bootstrap-admin.js` — the same command an operator is documented to use — with CI-provided `ADMIN_EMAIL` and `ADMIN_PASSWORD`, assert an `ADMIN` row exists afterward, run the bootstrap a **second** time and assert it is idempotent and does not overwrite the existing password, and make **no unrelated CI changes**. The purpose is to prove the *shipped compiled artifact* works, not merely the source implementation. | §4.6.1 |

### 17.16 The coupling is unchanged and remains binding

The review did not relax the entry condition, and nothing in the fourteen decisions above weakens it:

> **`@Roles()`, `RolesGuard`, and the admin bootstrap ship as one indivisible implementation task (task 2).**
>
> **DoD:** *An operator can obtain an ADMIN from a fresh database using only documented commands, with no test factory and no hand-edited rows.*

17.1 (a real bootstrap path) and 17.10 (the guard) are two halves of one deliverable. Shipping either alone reproduces the failure described in §4.1: a control protecting routes no real account can reach, or a role no route enforces.
