# Phase 2 — Products, Categories, and Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the product catalog and the authorization layer that guards it, including the first production path to an `ADMIN` account.

**Architecture:** Two new feature modules (`categories`, `products`) following the Phase 1 module shape — thin controllers, services owning their Prisma queries, explicit response DTOs with static `from()` mappers. Authorization arrives as a third global guard (`RolesGuard`) registered after `JwtAuthGuard`, driven by a dependency-free `@Roles()` decorator in `common/`. Because nothing in Phase 1 can write `role`, the guard ships in the same commit as a compiled, idempotent admin-bootstrap script that runs from the built `dist/` output.

**Tech Stack:** Node 20, NestJS 11, TypeScript strict, Prisma 6.19.3 + PostgreSQL 16, Jest + Supertest, Swagger. **No new dependencies are added in this phase.**

**Spec:** `docs/superpowers/specs/2026-08-31-phase-2-products-design.md` (approved 2026-09-01, §17 authoritative)

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec and `CLAUDE.md`.

- **No new dependencies.** Not one. If a step seems to need a package, stop and raise it.
- **Guard order is `ThrottlerGuard → JwtAuthGuard → RolesGuard`** and is registration-order-dependent in `AppModule`. Never reorder.
- **`RolesGuard` is opt-in:** no `@Roles()` metadata → allow. `@Roles(...)` → enforce.
- **`RolesGuard` is registered under its own class token and aliased with `useExisting`**, exactly as `JwtAuthGuard` is, so `overrideProvider()` can target it. `overrideGuard()` silently no-ops against `APP_GUARD` providers.
- **`@Roles()` lives in `src/common/decorators/`** (metadata only). **`RolesGuard` lives in `src/modules/auth/guards/`** (consumes authenticated request state).
- **Admin write controllers carry class-level `@Roles(Role.ADMIN)`.** Public catalog reads carry `@Public()`.
- **`JwtAuthGuard` is not modified.** Phase 1 is not redesigned.
- **Money is integer minor units:** `priceCents Int` plus `currency String @default("USD")`. No floating-point price anywhere — not in schema, DTOs, Swagger examples, or fixtures.
- **`Product.categoryId` is required**; the relation is `onDelete: Restrict`. Category deletion must never cascade to products.
- **Public product detail returns 404 when `isActive = false`.** Admin reads may explicitly request inactive products.
- **`DELETE` a product = soft deactivation** (`isActive = false`, 204). Reactivation is `PATCH { isActive: true }`.
- **Sort fields are whitelisted** — `createdAt`, `priceCents`, `name` — enforced by a TypeScript enum plus `@IsEnum`. No free-form sort string reaches Prisma.
- **No text search.** No Redis/BullMQ. No image upload or object storage. No nested categories. No category delete route.
- **Do not touch `docs/deferred-limitations.md`** — no entry closed, deleted, or annotated.
- **`maxWorkers: 1` stays.** Factories insert through the Prisma client, never `$executeRaw`. Suites with fixed identifiers call `truncateAll()` in `beforeEach`. Heavy-traffic suites pass `{ throttleLimit }` to `createTestApp()` — it is a boolean trigger, not a numeric cap.
- **Response DTOs use explicit static `from()` mappers.** No object spread, no `plainToInstance`, never return a Prisma object from a controller.
- **`src/config/` is the only place reading `process.env`** (plus `test/`). Any new env var goes into `.env.example` **and** the Joi schema in the same commit.
- **The pagination primitives in `common/` are not reshaped speculatively** — only if the real product list proves a need, and then explicitly (Task 8).
- **Gate for every task:** `npm run lint:ci`, `npm run build`, `npm test` must pass. Tasks touching the database also run `npm run test:e2e`.
- **Commits:** this plan is the explicit instruction to commit. One commit per task, message given in the task. **Never push.** Do not create the Phase 2 branch as part of a task — the operator does that before Task 1.

### Unit-test mocking convention (match this exactly)

`src/modules/users/users.service.spec.ts` establishes the pattern that passes `lint:ci --max-warnings 0`. Declare the mock as a typed object literal of `jest.Mock` fields and hand it to `useValue`. Do **not** cast to `any`, do **not** use `as unknown as PrismaService`, and do **not** disable a lint rule:

```typescript
let prisma: { product: { findMany: jest.Mock; count: jest.Mock } };

beforeEach(async () => {
  prisma = { product: { findMany: jest.fn(), count: jest.fn() } };

  const module: TestingModule = await Test.createTestingModule({
    providers: [ProductsService, { provide: PrismaService, useValue: prisma }],
  }).compile();
});
```

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/common/decorators/roles.decorator.ts` | `ROLES_KEY` + `@Roles()` metadata decorator |
| `src/modules/auth/guards/roles.guard.ts` | Role enforcement; reads `request.user.role` |
| `src/modules/auth/guards/roles.guard.spec.ts` | Guard unit tests |
| `src/scripts/bootstrap-admin.ts` | `bootstrapAdmin()` core + CLI wrapper |
| `src/scripts/bootstrap-admin.spec.ts` | Bootstrap unit tests |
| `src/modules/categories/categories.module.ts` | Module wiring |
| `src/modules/categories/categories.service.ts` | Category queries |
| `src/modules/categories/categories.service.spec.ts` | Service unit tests |
| `src/modules/categories/categories.controller.ts` | Public `GET /categories` |
| `src/modules/categories/admin-categories.controller.ts` | Admin writes, class-level `@Roles` |
| `src/modules/categories/dto/*.ts` | `CreateCategoryDto`, `UpdateCategoryDto`, `CategoryResponseDto` |
| `src/modules/products/products.module.ts` | Module wiring |
| `src/modules/products/products.service.ts` | Product queries; required `visibility` |
| `src/modules/products/products.service.spec.ts` | Service unit tests |
| `src/modules/products/products.controller.ts` | Public reads |
| `src/modules/products/admin-products.controller.ts` | Admin list + writes, class-level `@Roles` |
| `src/modules/products/types/product-visibility.ts` | `ProductVisibility` union + `ProductWithCategory` |
| `src/modules/products/dto/*.ts` | Query, create, update, response DTOs |
| `test/factories/category.factory.ts` | Category fixtures via Prisma client |
| `test/factories/product.factory.ts` | Product fixtures via Prisma client |
| `test/fixtures/admin-probe.module.ts` | `@Roles(ADMIN)` probe route for guard-order tests |
| `test/roles-guard.e2e-spec.ts` | Guard chain + 401/403/200 matrix |
| `test/bootstrap-admin.e2e-spec.ts` | Bootstrap DoD test |
| `test/catalog.e2e-spec.ts` | Public catalog behaviour |
| `test/catalog-admin.e2e-spec.ts` | Admin authorization matrix + write flows |

**Modified**

| File | Change |
|---|---|
| `prisma/schema.prisma` | `Category`, `Product` |
| `src/app.module.ts` | Third `APP_GUARD`; import the two new modules |
| `src/modules/auth/auth.module.ts` | Provide/export `RolesGuard`; export `PasswordHasherService` |
| `src/modules/users/users.service.ts` | `ensureAdmin()` |
| `src/modules/users/users.service.spec.ts` | `ensureAdmin()` tests |
| `src/config/configuration.ts` | `admin.email`, `admin.password` |
| `src/config/env.validation.ts` | `ADMIN_EMAIL`, `ADMIN_PASSWORD` (optional) |
| `src/config/configuration.spec.ts`, `src/config/env.validation.spec.ts` | Coverage for the above |
| `.env.example` | The two new variables |
| `.github/workflows/ci.yml` | One new `bootstrap` job — nothing else |
| `CLAUDE.md`, `README.md` | Phase 2 conventions and routes |

**Explicitly not modified in any task:** `src/modules/auth/guards/jwt-auth.guard.ts`, `src/modules/auth/auth.service.ts`, `src/modules/auth/token.service.ts`, `src/modules/auth/refresh-token.service.ts`, `src/common/filters/http-exception.filter.ts`, `src/bootstrap.ts`, `test/jest-e2e.json`, `docs/deferred-limitations.md`, `package.json`.

---

## Task Dependency Order

```
1 schema ──┬─> 3 factories ──> 4 categories svc ──┐
           │                                       ├─> 6 public reads ──> 8 pagination ──┐
           └─> 5 products svc ─────────────────────┘         │                            ├─> 9 e2e ──> 10 docs
                                                              │                            │
2 guard + bootstrap (INDIVISIBLE) ────────────────────────────┴─> 7 admin routes ─────────┘
```

Task 2 depends only on Task 1 and may be implemented immediately after it. Tasks 4 and 5 are independent of each other.

---

## Task 1: Schema and migration

**Objective:** Add `Category` and `Product` to the Prisma schema and produce the phase's single migration, with a restrictive foreign key.

**Dependencies:** None (Phase 1 merged).

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated-timestamp>_add_product_and_category/migration.sql` (generated — never hand-written)

**Interfaces:**
- Produces: Prisma models `Category` and `Product`, and the generated types `Category`, `Product` from `@prisma/client` that every later task imports.

- [ ] **Step 1: Append the two models to `prisma/schema.prisma`**

Add below the existing `RefreshToken` model. Do not modify `User`, `RefreshToken`, or the `Role` enum.

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

`onDelete: Restrict` is load-bearing: `Cascade` would silently delete every product in a category when that category is deleted. `Restrict` makes the database answer 409 through the existing `P2003` mapping instead.

- [ ] **Step 2: Generate the migration**

Requires the dev database running: `docker compose up -d postgres`.

```bash
npm run prisma:migrate -- --name add_product_and_category
```

- [ ] **Step 3: Read the generated SQL and verify it says RESTRICT**

```bash
cat prisma/migrations/*_add_product_and_category/migration.sql
```

Expected, among the output:
- `CREATE TABLE "categories"` and `CREATE TABLE "products"`
- `CREATE UNIQUE INDEX "categories_name_key"` and `"categories_slug_key"`
- `CREATE INDEX "products_category_id_idx"` and `"products_is_active_created_at_idx"`
- `... FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE`

If it says `ON DELETE CASCADE`, the schema edit is wrong — fix the schema and regenerate. Never hand-edit the migration SQL.

- [ ] **Step 4: Verify the constraint in the live catalog**

Phase 1 verified `ON DELETE CASCADE` this way; the same check applied to the opposite expectation.

```bash
docker compose exec -T postgres psql -U postgres -d ecommerce_dev -tAc \
  "SELECT conname, confdeltype FROM pg_constraint WHERE conname = 'products_category_id_fkey';"
```

Expected: `products_category_id_fkey|r` — `r` is RESTRICT. A `c` here means cascade and is a failure.

- [ ] **Step 5: Verify the migration replays from empty**

The e2e Postgres is tmpfs-backed, so restarting it gives a genuinely cold database. `test/global-setup.ts` then runs `prisma migrate deploy`.

```bash
docker compose restart postgres-test
npm run test:e2e -- test/harness.e2e-spec.ts
```

Expected: PASS. This proves both migrations apply in order from nothing, which is what CI does on every run.

- [ ] **Step 6: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test
```

Expected: lint clean, build clean, 104 unit tests passing (Task 1 adds none).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add Product and Category models with restrictive category FK"
```

**Tests:** None. This task is schema-only, matching the Phase 1 precedent (its model task shipped with no spec file). The migration is exercised by every later e2e run.

**Verification commands:** Steps 3–6 above.

**Definition of Done:**
- Both models present with `@@map`, `uuid(7)` ids, `createdAt`/`updatedAt`.
- Exactly one new migration directory, committed, never edited by hand.
- `confdeltype = 'r'` confirmed.
- Migration replays against a cold database.
- Lint, build, unit tests green.

**Known risks:**
- *Prisma generates `ON DELETE CASCADE` if the schema says so.* Step 3 is the catch.
- *`prisma migrate dev` may create a shadow database.* This is normal and needs no action; it requires the dev Postgres on 5432 to be up.
- *Running against the wrong database.* `npm run prisma:migrate` reads `DATABASE_URL` from `.env` — confirm it points at `ecommerce_dev` on 5432, not the test database on 5433.

**Out of scope:** No `parentId` on `Category`. No product `slug`. No stock/inventory fields. No seed data. No service, DTO, or controller code — this task adds zero TypeScript.

---

## Task 2: `@Roles()` + `RolesGuard` + admin bootstrap — ONE INDIVISIBLE TASK

**Objective:** Ship authorization and the only production path that can produce an `ADMIN`, together, in a single commit.

> **This task must not be split.** Spec §4.1 and §17.16. A guard shipped without a bootstrap protects routes no real account can reach and is exercisable only through a test factory; a bootstrap shipped without the guard creates a role no route enforces. Landing the CI verification separately means the artifact ships unverified in the interval, which is the gap §17.15 exists to close. If this task feels too large, that is the design working as intended — implement it in the step order below and commit once at the end.

**Dependencies:** Task 1 (needs no product models, but shares the phase's migration baseline).

**Files:**
- Create: `src/common/decorators/roles.decorator.ts`
- Create: `src/modules/auth/guards/roles.guard.ts`, `src/modules/auth/guards/roles.guard.spec.ts`
- Create: `src/scripts/bootstrap-admin.ts`, `src/scripts/bootstrap-admin.spec.ts`
- Create: `test/fixtures/admin-probe.module.ts`, `test/roles-guard.e2e-spec.ts`, `test/bootstrap-admin.e2e-spec.ts`
- Modify: `src/modules/auth/auth.module.ts`, `src/app.module.ts`, `src/modules/users/users.service.ts`, `src/modules/users/users.service.spec.ts`, `src/config/configuration.ts`, `src/config/configuration.spec.ts`, `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`, `.env.example`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `AuthenticatedUser` (`{ sub: string; role: Role }`) from `src/modules/auth/types/authenticated-user.ts`; `PasswordHasherService.hash(plain: string): Promise<string>`; `UsersService`.
- Produces:
  - `ROLES_KEY: string` and `Roles(...roles: Role[]): CustomDecorator` from `src/common/decorators/roles.decorator.ts`
  - `RolesGuard` (class token, exported by `AuthModule`)
  - `UsersService.ensureAdmin(input: { email: string; passwordHash: string }): Promise<{ user: User; outcome: 'created' | 'promoted' | 'unchanged' }>`
  - `bootstrapAdmin(deps: BootstrapDeps): Promise<'created' | 'promoted' | 'unchanged'>` from `src/scripts/bootstrap-admin.ts`
  - `AppConfig.admin: { email: string | undefined; password: string | undefined }`

- [ ] **Step 1: Write the `RolesGuard` failing tests**

Create `src/modules/auth/guards/roles.guard.spec.ts`:

```typescript
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';

interface MockRequest {
  user?: { sub: string; role: Role };
}

function contextFor(request: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows a route with no @Roles() metadata', () => {
    reflector.getAllAndOverride.mockReturnValueOnce(undefined);

    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('allows a route whose @Roles() list is empty', () => {
    reflector.getAllAndOverride.mockReturnValueOnce([]);

    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('allows a caller holding the required role', () => {
    reflector.getAllAndOverride.mockReturnValueOnce([Role.ADMIN]);

    const context = contextFor({ user: { sub: 'u1', role: Role.ADMIN } });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies a caller holding a different role', () => {
    reflector.getAllAndOverride.mockReturnValueOnce([Role.ADMIN]);

    const context = contextFor({ user: { sub: 'u1', role: Role.CUSTOMER } });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('denies when metadata is present but no user was attached', () => {
    // Only reachable if a route carries both @Public() and @Roles(), which is
    // a configuration error. It must deny rather than crash, and it must not
    // report 401 — authentication is JwtAuthGuard's answer, not this guard's.
    reflector.getAllAndOverride.mockReturnValueOnce([Role.ADMIN]);

    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/modules/auth/guards/roles.guard.spec.ts
```

Expected: FAIL — `Cannot find module './roles.guard'`.

- [ ] **Step 3: Write the decorator**

Create `src/common/decorators/roles.decorator.ts`:

```typescript
import { CustomDecorator, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Marks a route (or a whole controller) as requiring one of the listed roles.
 *
 * Metadata only, with no injected dependency, which is why it lives in
 * `common/` beside `@Public()` while the guard that reads it lives in
 * `modules/auth/` — the guard consumes `AuthenticatedUser`, and pointing
 * `common/` at a feature module would invert the layering.
 */
export const Roles = (...roles: Role[]): CustomDecorator =>
  SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 4: Write the guard**

Create `src/modules/auth/guards/roles.guard.ts`:

```typescript
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Authorization is opt-in, the inverse of JwtAuthGuard's default-deny.
    // Authentication has a safe universal default (require it); authorization
    // does not — a fail-closed default would have to invent a required role
    // for every route, including the public catalog. The residual risk (a
    // write route that forgets @Roles()) is handled structurally by putting
    // every admin route on a controller with a class-level decorator, and by
    // a per-route 403 assertion in the e2e suite.
    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    // No principal on a role-restricted route means the route also carries
    // @Public(), which is a misconfiguration. Deny — and deny with 403, not
    // 401: reporting an authentication failure here would misattribute the
    // fault and hand the caller a misleading retry.
    if (!user) {
      throw new ForbiddenException('Forbidden');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException('Forbidden');
    }

    return true;
  }
}
```

- [ ] **Step 5: Run the guard tests to verify they pass**

```bash
npm test -- src/modules/auth/guards/roles.guard.spec.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing `ensureAdmin()` tests**

Append to `src/modules/users/users.service.spec.ts`. Extend the existing `prisma` mock declaration to include the methods used here — change the declaration and the `beforeEach` initialiser to:

```typescript
let prisma: {
  user: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};

beforeEach(async () => {
  prisma = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  // ...unchanged module setup
});
```

Then add:

```typescript
describe('ensureAdmin', () => {
  it('creates an ADMIN when the email is unknown', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce({ id: 'u1', role: Role.ADMIN });

    const result = await service.ensureAdmin({
      email: 'Boss@Example.TEST',
      passwordHash: 'digest',
    });

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        email: 'boss@example.test',
        passwordHash: 'digest',
        role: Role.ADMIN,
      },
    });
    expect(result.outcome).toBe('created');
  });

  it('promotes an existing CUSTOMER without touching the password', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u1',
      role: Role.CUSTOMER,
      passwordHash: 'original-digest',
    });
    prisma.user.update.mockResolvedValueOnce({ id: 'u1', role: Role.ADMIN });

    const result = await service.ensureAdmin({
      email: 'boss@example.test',
      passwordHash: 'a-brand-new-digest',
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: Role.ADMIN },
    });

    // The decisive assertion: the update payload carries no passwordHash.
    // A bootstrap that silently resets a live account's credentials whenever
    // an env var is set is a foot-gun and an escalation path.
    const updateArg = prisma.user.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data).not.toHaveProperty('passwordHash');
    expect(result.outcome).toBe('promoted');
  });

  it('writes nothing when the user is already an ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u1',
      role: Role.ADMIN,
    });

    const result = await service.ensureAdmin({
      email: 'boss@example.test',
      passwordHash: 'digest',
    });

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(result.outcome).toBe('unchanged');
  });
});
```

Add `import { Role } from '@prisma/client';` to the spec's imports.

- [ ] **Step 7: Run to verify failure**

```bash
npm test -- src/modules/users/users.service.spec.ts
```

Expected: FAIL — `service.ensureAdmin is not a function`.

- [ ] **Step 8: Implement `ensureAdmin()`**

Add to `src/modules/users/users.service.ts` (leave `CreateUserInput` and `create()` untouched):

```typescript
export interface EnsureAdminInput {
  email: string;
  passwordHash: string;
}

export type EnsureAdminOutcome = 'created' | 'promoted' | 'unchanged';

export interface EnsureAdminResult {
  user: User;
  outcome: EnsureAdminOutcome;
}
```

and the method:

```typescript
  /**
   * Idempotent admin bootstrap.
   *
   * Deliberately separate from `create()`: `CreateUserInput` has no `role`
   * field, which is what makes it impossible for registration to mint an
   * ADMIN. Widening that type to serve the bootstrap would weaken a tested
   * Phase 1 invariant, so the privileged write gets its own named method.
   *
   * Never writes `passwordHash` for a user that already exists — promotion
   * and password reset are different operations, and only the first ships.
   */
  async ensureAdmin(input: EnsureAdminInput): Promise<EnsureAdminResult> {
    const email = input.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (!existing) {
      const user = await this.prisma.user.create({
        data: { email, passwordHash: input.passwordHash, role: Role.ADMIN },
      });

      return { user, outcome: 'created' };
    }

    if (existing.role === Role.ADMIN) {
      return { user: existing, outcome: 'unchanged' };
    }

    const user = await this.prisma.user.update({
      where: { id: existing.id },
      data: { role: Role.ADMIN },
    });

    return { user, outcome: 'promoted' };
  }
```

Add `Role` to the existing `@prisma/client` import.

- [ ] **Step 9: Run to verify the tests pass**

```bash
npm test -- src/modules/users/users.service.spec.ts
```

Expected: PASS, 7 tests (4 existing + 3 new).

- [ ] **Step 10: Add the configuration**

`src/config/configuration.ts` — extend the `AppConfig` interface:

```typescript
  admin: {
    email: string | undefined;
    password: string | undefined;
  };
```

and the factory return value:

```typescript
  admin: {
    // Optional by design: the API must boot without bootstrap credentials.
    // The bootstrap script requires them at runtime and aborts loudly if
    // either is missing. They are never read on any request path.
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
```

`src/config/env.validation.ts` — add to the Joi object:

```typescript
  ADMIN_EMAIL: Joi.string().email().optional(),
  ADMIN_PASSWORD: Joi.string().min(8).max(128).optional(),
```

Bounds match `RegisterDto`, so a password accepted by the bootstrap is one the login endpoint would also accept.

`.env.example` — append:

```
# Admin bootstrap (optional; read only by the bootstrap script, never by the API)
# Run after building:  node dist/scripts/bootstrap-admin.js
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-after-first-login
```

- [ ] **Step 11: Add config tests**

Append to `src/config/configuration.spec.ts`:

```typescript
  it('exposes admin bootstrap credentials when they are set', () => {
    process.env.ADMIN_EMAIL = 'boss@example.test';
    process.env.ADMIN_PASSWORD = 'Test1234!';

    const config = configuration();

    expect(config.admin.email).toBe('boss@example.test');
    expect(config.admin.password).toBe('Test1234!');
  });

  it('leaves admin bootstrap credentials undefined when absent', () => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;

    const config = configuration();

    expect(config.admin.email).toBeUndefined();
    expect(config.admin.password).toBeUndefined();
  });
```

Follow the file's existing `beforeEach`/`afterEach` env save-and-restore convention — read the top of the file and match it rather than inventing new setup.

Append to `src/config/env.validation.spec.ts`:

```typescript
  it('accepts an environment with no admin bootstrap variables', () => {
    const { error } = envValidationSchema.validate(baseEnv);

    expect(error).toBeUndefined();
  });

  it('rejects a malformed ADMIN_EMAIL', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      ADMIN_EMAIL: 'not-an-email',
    });

    expect(error?.message).toContain('ADMIN_EMAIL');
  });

  it('rejects an ADMIN_PASSWORD below the minimum length', () => {
    const { error } = envValidationSchema.validate({
      ...baseEnv,
      ADMIN_PASSWORD: 'short',
    });

    expect(error?.message).toContain('ADMIN_PASSWORD');
  });
```

`baseEnv` is whatever the existing spec uses for a valid environment — reuse that helper; do not redefine it.

- [ ] **Step 12: Write the failing bootstrap tests**

Create `src/scripts/bootstrap-admin.spec.ts`:

```typescript
import { Role } from '@prisma/client';
import { bootstrapAdmin } from './bootstrap-admin';

describe('bootstrapAdmin', () => {
  let usersService: { ensureAdmin: jest.Mock };
  let passwordHasher: { hash: jest.Mock };

  beforeEach(() => {
    usersService = { ensureAdmin: jest.fn() };
    passwordHasher = { hash: jest.fn().mockResolvedValue('hashed-digest') };
  });

  const deps = (email?: string, password?: string) => ({
    email,
    password,
    usersService: usersService as never,
    passwordHasher: passwordHasher as never,
  });

  it('hashes the password with the real hasher and creates the admin', async () => {
    usersService.ensureAdmin.mockResolvedValueOnce({
      user: { id: 'u1', role: Role.ADMIN },
      outcome: 'created',
    });

    const outcome = await bootstrapAdmin(deps('boss@example.test', 'Test1234!'));

    expect(passwordHasher.hash).toHaveBeenCalledWith('Test1234!');
    expect(usersService.ensureAdmin).toHaveBeenCalledWith({
      email: 'boss@example.test',
      passwordHash: 'hashed-digest',
    });
    expect(outcome).toBe('created');
  });

  it('reports promotion of an existing user', async () => {
    usersService.ensureAdmin.mockResolvedValueOnce({
      user: { id: 'u1', role: Role.ADMIN },
      outcome: 'promoted',
    });

    await expect(
      bootstrapAdmin(deps('boss@example.test', 'Test1234!')),
    ).resolves.toBe('promoted');
  });

  it('is a no-op on a second run', async () => {
    usersService.ensureAdmin.mockResolvedValueOnce({
      user: { id: 'u1', role: Role.ADMIN },
      outcome: 'unchanged',
    });

    await expect(
      bootstrapAdmin(deps('boss@example.test', 'Test1234!')),
    ).resolves.toBe('unchanged');
  });

  it('aborts when ADMIN_EMAIL is missing', async () => {
    await expect(bootstrapAdmin(deps(undefined, 'Test1234!'))).rejects.toThrow(
      /ADMIN_EMAIL/,
    );
    expect(usersService.ensureAdmin).not.toHaveBeenCalled();
  });

  it('aborts when ADMIN_PASSWORD is missing', async () => {
    await expect(
      bootstrapAdmin(deps('boss@example.test', undefined)),
    ).rejects.toThrow(/ADMIN_PASSWORD/);
    expect(usersService.ensureAdmin).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 13: Run to verify failure**

```bash
npm test -- src/scripts/bootstrap-admin.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 14: Implement the bootstrap script**

Create `src/scripts/bootstrap-admin.ts`:

```typescript
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AppConfig } from '../config/configuration';
import { PasswordHasherService } from '../modules/auth/password-hasher.service';
import { UsersService } from '../modules/users/users.service';
import { EnsureAdminOutcome } from '../modules/users/users.service';

export interface BootstrapDeps {
  email: string | undefined;
  password: string | undefined;
  usersService: UsersService;
  passwordHasher: PasswordHasherService;
}

/**
 * The testable core. No process.exit, no context lifecycle — so a unit test
 * and the e2e suite can both drive the real logic.
 */
export async function bootstrapAdmin(
  deps: BootstrapDeps,
): Promise<EnsureAdminOutcome> {
  if (!deps.email) {
    throw new Error(
      'ADMIN_EMAIL is not set. The bootstrap has no default: refusing to run.',
    );
  }

  if (!deps.password) {
    throw new Error(
      'ADMIN_PASSWORD is not set. The bootstrap has no default: refusing to run.',
    );
  }

  const passwordHash = await deps.passwordHasher.hash(deps.password);
  const { outcome } = await deps.usersService.ensureAdmin({
    email: deps.email,
    passwordHash,
  });

  return outcome;
}

/**
 * CLI wrapper. Documented operator command, and the exact command CI runs:
 *
 *   node dist/scripts/bootstrap-admin.js
 *
 * Reads configuration through ConfigService rather than process.env, so the
 * `src/config/` rule holds and Joi validation applies to the script too.
 */
async function main(): Promise<void> {
  const logger = new Logger('BootstrapAdmin');
  const context = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const configService = context.get(ConfigService<AppConfig, true>);
    const outcome = await bootstrapAdmin({
      email: configService.get('admin.email', { infer: true }),
      password: configService.get('admin.password', { infer: true }),
      usersService: context.get(UsersService),
      passwordHasher: context.get(PasswordHasherService),
    });

    // Never log the password or the digest.
    logger.log(`Admin bootstrap complete: ${outcome}`);

    if (outcome === 'created') {
      logger.warn(
        'Change this password after first login and remove ADMIN_PASSWORD from the environment.',
      );
    }
  } finally {
    await context.close();
  }
}

// Only run when executed directly, so importing the core in a test does not
// boot an application context.
if (require.main === module) {
  main().catch((error: unknown) => {
    new Logger('BootstrapAdmin').error(
      error instanceof Error ? error.message : 'Admin bootstrap failed',
    );
    process.exitCode = 1;
  });
}
```

- [ ] **Step 15: Run to verify the tests pass**

```bash
npm test -- src/scripts/bootstrap-admin.spec.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 16: Wire the guard and the export into `AuthModule`**

`src/modules/auth/auth.module.ts` — add `RolesGuard` to `providers` and extend `exports`:

```typescript
  providers: [
    AuthService,
    PasswordHasherService,
    TokenService,
    RefreshTokenService,
    JwtAuthGuard,
    RolesGuard,
  ],
  // PasswordHasherService is exported so the bootstrap script hashes with the
  // real Argon2id hasher and its real cost parameters, rather than a second
  // implementation that could drift.
  exports: [TokenService, JwtAuthGuard, RolesGuard, PasswordHasherService],
```

- [ ] **Step 17: Register the third global guard**

`src/app.module.ts` — add to `providers`, **after** the existing `JwtAuthGuard` alias:

```typescript
    ThrottlerGuard,
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    // RolesGuard runs third and must stay third: it reads request.user, which
    // JwtAuthGuard populates. Registered via useExisting against AuthModule's
    // class-token provider for the same reason JwtAuthGuard is — APP_GUARD
    // providers are invisible to overrideGuard(), so tests need a real
    // injectable token to target with overrideProvider().
    { provide: APP_GUARD, useExisting: RolesGuard },
```

Add the import: `import { RolesGuard } from './modules/auth/guards/roles.guard';`

- [ ] **Step 18: Create the guard-order probe fixture**

`RolesGuard` needs a role-restricted route to be observable end to end, and no product routes exist yet. This mirrors `test/fixtures/protected-throttle-probe.module.ts`, which exists for exactly this reason.

Create `test/fixtures/admin-probe.module.ts`:

```typescript
import { Controller, Get, Module } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../src/common/decorators/roles.decorator';

// A role-restricted route that exists only for tests. It lets the guard chain
// be asserted before any admin domain route exists, and it is never imported
// by AppModule, so it ships in no production build.
@Controller({ path: 'admin-probe', version: '1' })
@Roles(Role.ADMIN)
export class AdminProbeController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [AdminProbeController] })
export class AdminProbeModule {}
```

- [ ] **Step 19: Write the guard-chain e2e**

Create `test/roles-guard.e2e-spec.ts`:

```typescript
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser, TEST_PASSWORD } from './factories/user.factory';
import { AdminProbeModule } from './fixtures/admin-probe.module';
import { PrismaService } from '../src/prisma/prisma.service';

interface AuthBody {
  accessToken: string;
}

describe('roles guard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp([AdminProbeModule], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const login = async (email: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

    return (response.body as AuthBody).accessToken;
  };

  it('returns 401, not 403, when no token is presented', async () => {
    // This is the guard-order assertion. JwtAuthGuard must reject first; if
    // RolesGuard ran before it, request.user would be undefined and the
    // caller would see 403 — the wrong answer and the wrong diagnosis.
    await request(app.getHttpServer()).get('/api/v1/admin-probe').expect(401);
  });

  it('returns 403 for an authenticated CUSTOMER', async () => {
    const user = await createUser(prisma, { role: Role.CUSTOMER });
    const token = await login(user.email);

    await request(app.getHttpServer())
      .get('/api/v1/admin-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('allows an ADMIN', async () => {
    const user = await createUser(prisma, { role: Role.ADMIN });
    const token = await login(user.email);

    await request(app.getHttpServer())
      .get('/api/v1/admin-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('leaves routes without @Roles() reachable by any authenticated caller', async () => {
    const user = await createUser(prisma, { role: Role.CUSTOMER });
    const token = await login(user.email);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('keeps @Public() routes public with the third guard installed', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
```

- [ ] **Step 20: Write the bootstrap DoD e2e**

Create `test/bootstrap-admin.e2e-spec.ts`. This is §4.2 expressed as a test: **no user factory appears in this file.**

```typescript
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { AdminProbeModule } from './fixtures/admin-probe.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordHasherService } from '../src/modules/auth/password-hasher.service';
import { UsersService } from '../src/modules/users/users.service';
import { bootstrapAdmin } from '../src/scripts/bootstrap-admin';

const ADMIN_EMAIL = 'bootstrap-admin@example.test';
const ADMIN_PASSWORD = 'Bootstrap1234!';

interface AuthBody {
  accessToken: string;
  user: { role: string };
}

describe('admin bootstrap (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let usersService: UsersService;
  let passwordHasher: PasswordHasherService;

  beforeAll(async () => {
    app = await createTestApp([AdminProbeModule], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
    usersService = app.get(UsersService);
    passwordHasher = app.get(PasswordHasherService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const run = (): Promise<string> =>
    bootstrapAdmin({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      usersService,
      passwordHasher,
    });

  it('produces an ADMIN that can log in and reach a role-restricted route', async () => {
    expect(await run()).toBe('created');

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    const body = login.body as AuthBody;
    expect(body.user.role).toBe(Role.ADMIN);

    await request(app.getHttpServer())
      .get('/api/v1/admin-probe')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
  });

  it('is idempotent and never rewrites an existing password', async () => {
    expect(await run()).toBe('created');

    const first = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN_EMAIL },
    });

    expect(await run()).toBe('unchanged');

    const second = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN_EMAIL },
    });

    expect(second.passwordHash).toBe(first.passwordHash);
    expect(second.role).toBe(Role.ADMIN);
    expect(await prisma.user.count({ where: { email: ADMIN_EMAIL } })).toBe(1);
  });

  it('promotes an existing customer and leaves their password working', async () => {
    // Registered through the real public endpoint — not a factory — so this
    // exercises the promotion path an operator actually hits.
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(201);

    expect(await run()).toBe('promoted');

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    expect((login.body as AuthBody).user.role).toBe(Role.ADMIN);
  });
});
```

- [ ] **Step 21: Run the new e2e suites**

```bash
docker compose up -d postgres-test
npm run test:e2e -- test/roles-guard.e2e-spec.ts test/bootstrap-admin.e2e-spec.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 22: Add the CI bootstrap job**

Append one job to `.github/workflows/ci.yml`. **Change nothing else in that file** — not the `build`, `e2e`, or `docker` jobs, not action versions, not caching.

```yaml
  bootstrap:
    name: Compiled admin bootstrap
    runs-on: ubuntu-latest

    # Proves the SHIPPED COMPILED ARTIFACT works: it builds the app and runs
    # the exact command README documents for an operator, against a fresh
    # database, twice.
    #
    # What it deliberately does NOT prove: that the Docker runtime image
    # starts, connects, and serves. This job runs `node dist/...` on the
    # runner, not inside the image. docs/deferred-limitations.md's runtime
    # image entry stays open and owned by Phase 6.
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: ecommerce_bootstrap
        # 5434, distinct from dev (5432) and e2e (5433), so no job can
        # accidentally bootstrap another job's database.
        ports:
          - 5434:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5434/ecommerce_bootstrap
      JWT_SECRET: ci-only-secret-not-used-outside-continuous-integration
      ADMIN_EMAIL: ci-admin@example.test
      ADMIN_PASSWORD: CiBootstrap1234!
      PGPASSWORD: postgres

    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Generate Prisma client
        run: npm run prisma:generate

      - name: Build
        run: npm run build

      - name: Apply migrations
        run: npx prisma migrate deploy

      - name: Bootstrap the admin (first run)
        run: node dist/scripts/bootstrap-admin.js

      - name: Assert an ADMIN row exists, and capture its digest
        run: |
          set -euo pipefail
          ROLE=$(psql -h localhost -p 5434 -U postgres -d ecommerce_bootstrap -tAc \
            "SELECT role FROM users WHERE email = '$ADMIN_EMAIL';")
          test "$ROLE" = "ADMIN"
          psql -h localhost -p 5434 -U postgres -d ecommerce_bootstrap -tAc \
            "SELECT password_hash FROM users WHERE email = '$ADMIN_EMAIL';" > /tmp/hash-before
          test -s /tmp/hash-before

      - name: Bootstrap the admin (second run)
        run: node dist/scripts/bootstrap-admin.js

      - name: Assert idempotent and the password was not rewritten
        run: |
          set -euo pipefail
          COUNT=$(psql -h localhost -p 5434 -U postgres -d ecommerce_bootstrap -tAc \
            "SELECT count(*) FROM users WHERE email = '$ADMIN_EMAIL';")
          test "$COUNT" = "1"
          ROLE=$(psql -h localhost -p 5434 -U postgres -d ecommerce_bootstrap -tAc \
            "SELECT role FROM users WHERE email = '$ADMIN_EMAIL';")
          test "$ROLE" = "ADMIN"
          psql -h localhost -p 5434 -U postgres -d ecommerce_bootstrap -tAc \
            "SELECT password_hash FROM users WHERE email = '$ADMIN_EMAIL';" > /tmp/hash-after
          # The assertion that actually pins the never-overwrite rule.
          # Exit-code-only checking would pass against a script that silently
          # reset the credential on every run.
          diff /tmp/hash-before /tmp/hash-after
```

- [ ] **Step 23: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Expected: lint clean; build clean; **122 unit tests** (104 + 5 guard + 3 `ensureAdmin` + 5 bootstrap + 2 configuration + 3 env validation); **43 e2e tests** (35 + 5 roles-guard + 3 bootstrap).

- [ ] **Step 24: Verify the workflow file parses**

```bash
node -e "const f=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/^  bootstrap:$/m.test(f)) throw new Error('bootstrap job missing'); console.log('job present');"
git diff --stat .github/workflows/ci.yml
```

Expected: `job present`, and the diff shows **only additions** to `ci.yml`.

- [ ] **Step 25: Commit — one commit for the whole task**

```bash
git add src/common/decorators/roles.decorator.ts \
        src/modules/auth/guards/roles.guard.ts \
        src/modules/auth/guards/roles.guard.spec.ts \
        src/modules/auth/auth.module.ts \
        src/app.module.ts \
        src/modules/users/users.service.ts \
        src/modules/users/users.service.spec.ts \
        src/scripts/bootstrap-admin.ts \
        src/scripts/bootstrap-admin.spec.ts \
        src/config/configuration.ts src/config/configuration.spec.ts \
        src/config/env.validation.ts src/config/env.validation.spec.ts \
        .env.example .github/workflows/ci.yml \
        test/fixtures/admin-probe.module.ts \
        test/roles-guard.e2e-spec.ts test/bootstrap-admin.e2e-spec.ts
git commit -m "feat: add role-based authorization with an admin bootstrap path"
```

**Tests:** 13 new unit tests (5 guard, 3 `ensureAdmin`, 5 bootstrap) plus 5 config tests; 8 new e2e tests; 1 CI job with 4 assertions.

**Verification commands:** Steps 5, 9, 15, 21, 23, 24.

**Definition of Done:**
- `@Roles()` in `common/decorators/`, `RolesGuard` in `auth/guards/`.
- Guard order `ThrottlerGuard → JwtAuthGuard → RolesGuard`, proven by the "401 not 403 with no token" test.
- `RolesGuard` registered under its class token + `useExisting`, so `overrideProvider()` can target it.
- `ensureAdmin()` creates, promotes, and no-ops, and **never** writes `passwordHash` for an existing user — asserted on the update payload.
- **An operator can obtain an ADMIN from a fresh database using only documented commands, with no test factory and no hand-edited rows** — proven by `test/bootstrap-admin.e2e-spec.ts`, which contains no factory import.
- CI job builds, migrates a fresh database, runs `node dist/scripts/bootstrap-admin.js` twice, and diffs `password_hash` across runs.
- `ADMIN_EMAIL`/`ADMIN_PASSWORD` optional in Joi; the API still boots without them.
- Everything above in **one commit**.

**Known risks:**
- *Splitting the commit.* The single largest risk in the phase. If review pressure suggests splitting, re-read §4.1 — the split is what produces an unreachable security control.
- *Registering `RolesGuard` before `JwtAuthGuard`.* Produces 403 where 401 belongs; the first e2e test catches it.
- *Using `overrideGuard()` in a future test.* Silently no-ops. Always `overrideProvider()`.
- *`createApplicationContext` runs every `onModuleInit`*, including `AuthService`'s argon2 dummy-digest derivation (~100 ms). Expected, not a defect.
- *`psql` availability on the runner.* Present on `ubuntu-latest`. If a future runner image drops it, replace the assertions with a small Node script using the generated Prisma client — never by weakening them to exit-code checks.
- *`ADMIN_EMAIL` case.* `ensureAdmin()` lowercases; keep the CI value lowercase so the SQL assertions match.

**Out of scope:** No admin promotion endpoint (`PATCH /users/:id/role`) — it cannot bootstrap and is not in Phase 2. No password reset. No `role` field on `CreateUserInput`. No change to `JwtAuthGuard`, `register()`, or the throttler. No npm script alias for the bootstrap command — one documented invocation, one place, so CI and the README cannot drift.

---

## Task 3: Category and product test factories

**Objective:** Give every later task a way to insert catalog fixtures through the Prisma client.

**Dependencies:** Task 1.

**Files:**
- Create: `test/factories/category.factory.ts`, `test/factories/product.factory.ts`

**Interfaces:**
- Produces:
  - `createCategory(prisma: PrismaService, overrides?: Partial<Prisma.CategoryCreateInput>): Promise<Category>`
  - `createProduct(prisma: PrismaService, categoryId: string, overrides?: Partial<Prisma.ProductUncheckedCreateInput>): Promise<Product>`

- [ ] **Step 1: Write the category factory**

Create `test/factories/category.factory.ts`:

```typescript
import { Category, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Safe ONLY because the e2e suite is serial (`maxWorkers: 1` in
 * test/jest-e2e.json). Do not reuse this pattern if per-worker isolation is
 * ever added — parallel workers would hand out colliding names and slugs.
 *
 * Resets to 0 for every spec file, because Jest gives each file its own module
 * registry. `categories.name` and `categories.slug` are both @unique, so a
 * suite that creates fixed fixtures without truncating first will collide with
 * P2002. Suites using this factory should call `truncateAll()` in `beforeEach`.
 */
let sequence = 0;

export async function createCategory(
  prisma: PrismaService,
  overrides: Partial<Prisma.CategoryCreateInput> = {},
): Promise<Category> {
  sequence += 1;

  return prisma.category.create({
    data: {
      name: `Category ${sequence}`,
      slug: `category-${sequence}`,
      ...overrides,
    },
  });
}
```

- [ ] **Step 2: Write the product factory**

Create `test/factories/product.factory.ts`:

```typescript
import { Prisma, Product } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Same serial-suite caveat as the category factory. */
let sequence = 0;

/**
 * `categoryId` is a required positional argument rather than an override,
 * because Product.categoryId is required and a product with a dangling
 * category raises P2003. Callers create a category first.
 *
 * Inserts through the Prisma client, never $executeRaw: ids use
 * `@default(uuid(7))`, which Prisma generates client-side, so a raw insert
 * would produce a row with no id.
 */
export async function createProduct(
  prisma: PrismaService,
  categoryId: string,
  overrides: Partial<Prisma.ProductUncheckedCreateInput> = {},
): Promise<Product> {
  sequence += 1;

  return prisma.product.create({
    data: {
      name: `Product ${sequence}`,
      description: `Description for product ${sequence}`,
      // Integer minor units, always. Never a decimal literal here.
      priceCents: 1000 + sequence,
      currency: 'USD',
      isActive: true,
      categoryId,
      ...overrides,
    },
  });
}
```

- [ ] **Step 3: Verify the factories compile and lint**

```bash
npm run lint:ci && npm run build
```

Expected: both clean. (`npm test` will not exercise these — the unit config's `rootDir` is `src`.)

- [ ] **Step 4: Prove the factories actually insert**

The factories have no consumer yet, and Phase 1 learned that an unproven factory is a liability — its user factory sat with zero consumers until Task 12 exposed it. Add a temporary check rather than waiting:

```bash
npm run test:e2e -- test/harness.e2e-spec.ts
```

Then confirm in a throwaway Node REPL against the test database, or simply proceed — **Task 4's service spec does not use them, but Task 9's e2e does.** To avoid shipping an unexercised factory, Task 6's e2e smoke test (Step 9 of that task) is the designated first consumer and must land before the phase is considered done.

- [ ] **Step 5: Commit**

```bash
git add test/factories/category.factory.ts test/factories/product.factory.ts
git commit -m "test: add category and product factories"
```

**Tests:** None of their own (factories are test infrastructure). First exercised by Task 6's e2e smoke test; heavily used in Task 9.

**Verification commands:** Step 3.

**Definition of Done:** Both factories exist, insert via the Prisma client, carry the serial-suite caveat comment, and use integer prices. Lint and build clean.

**Known risks:**
- *An unexercised factory is unverified.* Tracked: Task 6 is the designated first consumer.
- *Spreading `overrides` before the defaults* would make overrides unusable. Keep the spread last.

**Out of scope:** No `Faker`-style random data (no new dependency). No factory for inactive products specifically — callers pass `{ isActive: false }`.

---

## Task 4: `CategoriesService`

**Objective:** Category reads and writes, with unique-constraint violations left to the global filter.

**Dependencies:** Task 1.

**Files:**
- Create: `src/modules/categories/categories.service.ts`, `src/modules/categories/categories.service.spec.ts`, `src/modules/categories/categories.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `PaginationQueryDto` (`page`, `limit`, `skip`).
- Produces:
  - `CategoriesService.list(query: PaginationQueryDto): Promise<{ items: Category[]; total: number }>`
  - `CategoriesService.create(input: { name: string; slug: string }): Promise<Category>`
  - `CategoriesService.update(id: string, input: { name?: string; slug?: string }): Promise<Category>`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/categories/categories.service.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let prisma: {
    category: {
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      category: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  const query = (page = 1, limit = 20): PaginationQueryDto => {
    const dto = new PaginationQueryDto();

    dto.page = page;
    dto.limit = limit;

    return dto;
  };

  it('lists categories ordered by name with pagination applied', async () => {
    prisma.$transaction.mockResolvedValueOnce([[{ id: 'c1' }], 1]);

    const result = await service.list(query(2, 10));

    expect(prisma.category.findMany).toHaveBeenCalledWith({
      skip: 10,
      take: 10,
      orderBy: { name: 'asc' },
    });
    expect(result).toEqual({ items: [{ id: 'c1' }], total: 1 });
  });

  it('creates a category with the supplied name and slug', async () => {
    prisma.category.create.mockResolvedValueOnce({ id: 'c1' });

    await service.create({ name: 'Desks', slug: 'desks' });

    expect(prisma.category.create).toHaveBeenCalledWith({
      data: { name: 'Desks', slug: 'desks' },
    });
  });

  it('updates only the supplied fields', async () => {
    prisma.category.update.mockResolvedValueOnce({ id: 'c1' });

    await service.update('c1', { name: 'Standing Desks' });

    expect(prisma.category.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { name: 'Standing Desks' },
    });
  });

  it('does not translate Prisma errors itself', async () => {
    // P2002 on a duplicate name/slug must travel to HttpExceptionFilter,
    // which already maps it to 409. Catching and re-throwing here would
    // translate the same error twice, in two places, with two messages.
    const failure = new Error('P2002');

    prisma.category.create.mockRejectedValueOnce(failure);

    await expect(
      service.create({ name: 'Desks', slug: 'desks' }),
    ).rejects.toBe(failure);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- src/modules/categories/categories.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/modules/categories/categories.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export interface CreateCategoryInput {
  name: string;
  slug: string;
}

export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
}

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: PaginationQueryDto,
  ): Promise<{ items: Category[]; total: number }> {
    // One round trip for both halves of the paginated response.
    const [items, total] = await this.prisma.$transaction([
      this.prisma.category.findMany({
        skip: query.skip,
        take: query.limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.category.count(),
    ]);

    return { items, total };
  }

  // P2002 on a duplicate name or slug propagates to HttpExceptionFilter,
  // which maps it to 409. Do not catch it here.
  async create(input: CreateCategoryInput): Promise<Category> {
    return this.prisma.category.create({ data: input });
  }

  // P2025 on an unknown id propagates and becomes a 404.
  async update(id: string, input: UpdateCategoryInput): Promise<Category> {
    return this.prisma.category.update({ where: { id }, data: input });
  }
}
```

Create `src/modules/categories/categories.module.ts` (controllers arrive in Tasks 6 and 7):

```typescript
import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';

@Module({
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
```

- [ ] **Step 4: Run to verify the tests pass**

```bash
npm test -- src/modules/categories/categories.service.spec.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npm run lint:ci && npm run build && npm test
git add src/modules/categories
git commit -m "feat: add categories service"
```

**Tests:** 4 unit tests with a mocked `PrismaService`.

**Verification commands:** Step 4, then the gate in Step 5.

**Definition of Done:** Service lists (paginated, ordered by name), creates, and updates. Prisma errors are not caught. Module provides and exports the service. Lint, build, unit tests green.

**Known risks:**
- *Catching `P2002` locally* would duplicate the filter's job and produce two different 409 messages. The fourth test pins this.
- *`$transaction` array form* returns a tuple; destructure it, do not index into `any`.

**Out of scope:** No delete route or delete method — category deletion needs an orphan policy and is out of Phase 2 (spec §9.5). No slug auto-generation. No nesting.

---

## Task 5: `ProductsService`

**Objective:** Product reads with a **required** visibility argument, filtering, whitelisted sorting, and writes.

**Dependencies:** Task 1.

**Files:**
- Create: `src/modules/products/types/product-visibility.ts`, `src/modules/products/products.service.ts`, `src/modules/products/products.service.spec.ts`, `src/modules/products/products.module.ts`
- Create: `src/modules/products/dto/product-list-query.dto.ts` (needed by the service signature)

**Interfaces:**
- Consumes: `PrismaService`, `PaginationQueryDto`.
- Produces:
  - `type ProductVisibility = 'active-only' | 'all' | 'inactive-only'`
  - `type ProductWithCategory = Prisma.ProductGetPayload<{ include: { category: true } }>`
  - `enum ProductSortField { CreatedAt = 'createdAt', PriceCents = 'priceCents', Name = 'name' }`
  - `enum SortOrder { Asc = 'asc', Desc = 'desc' }`
  - `class ProductListQueryDto extends PaginationQueryDto` — `categoryId?`, `minPriceCents?`, `maxPriceCents?`, `sort`, `order`
  - `ProductsService.list(query: ProductListQueryDto, visibility: ProductVisibility): Promise<{ items: ProductWithCategory[]; total: number }>`
  - `ProductsService.findOne(id: string, visibility: ProductVisibility): Promise<ProductWithCategory>`
  - `ProductsService.create(input: CreateProductInput): Promise<ProductWithCategory>`
  - `ProductsService.update(id: string, input: UpdateProductInput): Promise<ProductWithCategory>`
  - `ProductsService.deactivate(id: string): Promise<void>`

- [ ] **Step 1: Write the shared types**

Create `src/modules/products/types/product-visibility.ts`:

```typescript
import { Prisma } from '@prisma/client';

/**
 * Which slice of the catalog a read may see.
 *
 * Every read method takes this as a REQUIRED argument. A default of
 * 'active-only' would be safe but silent; a caller that forgets it should
 * fail to compile, because the failure this guards against — a future phase
 * quietly reading deactivated products into an order — is exactly the kind a
 * default hides. Same rule Phase 1 applied by leaving `role` off
 * CreateUserInput: make the unsafe call unrepresentable.
 */
export type ProductVisibility = 'active-only' | 'all' | 'inactive-only';

/** Products are always returned with their category joined. */
export type ProductWithCategory = Prisma.ProductGetPayload<{
  include: { category: true };
}>;

export function visibilityFilter(
  visibility: ProductVisibility,
): { isActive?: boolean } {
  switch (visibility) {
    case 'active-only':
      return { isActive: true };
    case 'inactive-only':
      return { isActive: false };
    case 'all':
      return {};
  }
}
```

- [ ] **Step 2: Write the query DTO**

Create `src/modules/products/dto/product-list-query.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * The sort whitelist. An enum plus @IsEnum means an unlisted value is
 * rejected by the global ValidationPipe with a 400 and NEVER reaches Prisma.
 * A free-form sort string handed to an ORM is an injection-shaped surface and
 * an unbounded index problem.
 */
export enum ProductSortField {
  CreatedAt = 'createdAt',
  PriceCents = 'priceCents',
  Name = 'name',
}

export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}

export class ProductListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter to one category' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ minimum: 0, description: 'Inclusive lower bound, minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceCents?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Inclusive upper bound, minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceCents?: number;

  @ApiPropertyOptional({ enum: ProductSortField, default: ProductSortField.CreatedAt })
  @IsEnum(ProductSortField)
  sort: ProductSortField = ProductSortField.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsEnum(SortOrder)
  order: SortOrder = SortOrder.Desc;
}
```

- [ ] **Step 3: Write the failing service tests**

Create `src/modules/products/products.service.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProductListQueryDto,
  ProductSortField,
  SortOrder,
} from './dto/product-list-query.dto';

describe('ProductsService', () => {
  let service: ProductsService;
  let prisma: {
    product: {
      findMany: jest.Mock;
      count: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      product: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([[], 0]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  const query = (
    overrides: Partial<ProductListQueryDto> = {},
  ): ProductListQueryDto => Object.assign(new ProductListQueryDto(), overrides);

  it('restricts a public list to active products', async () => {
    await service.list(query(), 'active-only');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it('applies no isActive filter when visibility is all', async () => {
    await service.list(query(), 'all');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('restricts to inactive products when asked', async () => {
    await service.list(query(), 'inactive-only');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: false } }),
    );
  });

  it('translates category and price filters into the where clause', async () => {
    await service.list(
      query({
        categoryId: '0195f0a0-0000-7000-8000-000000000000',
        minPriceCents: 1000,
        maxPriceCents: 5000,
      }),
      'active-only',
    );

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          categoryId: '0195f0a0-0000-7000-8000-000000000000',
          priceCents: { gte: 1000, lte: 5000 },
        },
      }),
    );
  });

  it('defaults to newest first', async () => {
    await service.list(query(), 'active-only');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    );
  });

  it('sorts by a whitelisted field in the requested direction', async () => {
    await service.list(
      query({ sort: ProductSortField.PriceCents, order: SortOrder.Asc }),
      'active-only',
    );

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { priceCents: 'asc' } }),
    );
  });

  it('applies pagination and always joins the category', async () => {
    await service.list(query({ page: 3, limit: 10 }), 'active-only');

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 10,
        include: { category: true },
      }),
    );
  });

  it('returns items and total from one transaction', async () => {
    prisma.$transaction.mockResolvedValueOnce([[{ id: 'p1' }], 7]);

    const result = await service.list(query(), 'active-only');

    expect(result).toEqual({ items: [{ id: 'p1' }], total: 7 });
  });

  it('finds one product within the requested visibility', async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: 'p1' });

    const result = await service.findOne('p1', 'active-only');

    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', isActive: true },
      include: { category: true },
    });
    expect(result).toEqual({ id: 'p1' });
  });

  it('throws 404 when the product is outside the requested visibility', async () => {
    // An inactive product on the public path must read as absent, not as
    // present-but-hidden. Enforcing this on the list and forgetting it here
    // is the specific defect this design guards against.
    prisma.product.findFirst.mockResolvedValueOnce(null);

    await expect(service.findOne('p1', 'active-only')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('deactivates rather than deleting', async () => {
    prisma.product.update.mockResolvedValueOnce({ id: 'p1' });

    await service.deactivate('p1');

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { isActive: false },
    });
  });

  it('creates a product and returns it with its category', async () => {
    prisma.product.create.mockResolvedValueOnce({ id: 'p1' });

    await service.create({
      name: 'Desk Lamp',
      description: 'A lamp',
      priceCents: 4999,
      currency: 'USD',
      categoryId: 'c1',
    });

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        name: 'Desk Lamp',
        description: 'A lamp',
        priceCents: 4999,
        currency: 'USD',
        categoryId: 'c1',
      },
      include: { category: true },
    });
  });
});
```

- [ ] **Step 4: Run to verify failure**

```bash
npm test -- src/modules/products/products.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 5: Implement the service**

Create `src/modules/products/products.service.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductListQueryDto } from './dto/product-list-query.dto';
import {
  ProductVisibility,
  ProductWithCategory,
  visibilityFilter,
} from './types/product-visibility';

export interface CreateProductInput {
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  imageUrl?: string;
  categoryId: string;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  priceCents?: number;
  currency?: string;
  imageUrl?: string | null;
  categoryId?: string;
  isActive?: boolean;
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `visibility` is required, never defaulted. See types/product-visibility.ts.
   */
  async list(
    query: ProductListQueryDto,
    visibility: ProductVisibility,
  ): Promise<{ items: ProductWithCategory[]; total: number }> {
    const where: Prisma.ProductWhereInput = { ...visibilityFilter(visibility) };

    if (query.categoryId !== undefined) {
      where.categoryId = query.categoryId;
    }

    if (query.minPriceCents !== undefined || query.maxPriceCents !== undefined) {
      where.priceCents = {
        ...(query.minPriceCents !== undefined
          ? { gte: query.minPriceCents }
          : {}),
        ...(query.maxPriceCents !== undefined
          ? { lte: query.maxPriceCents }
          : {}),
      };
    }

    // query.sort is a ProductSortField, so this object can only ever name a
    // whitelisted column — the ValidationPipe rejected anything else with a
    // 400 before the request reached this service.
    const orderBy = { [query.sort]: query.order } as Prisma.ProductOrderByWithRelationInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        skip: query.skip,
        take: query.limit,
        orderBy,
        include: { category: true },
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total };
  }

  async findOne(
    id: string,
    visibility: ProductVisibility,
  ): Promise<ProductWithCategory> {
    const product = await this.prisma.product.findFirst({
      where: { id, ...visibilityFilter(visibility) },
      include: { category: true },
    });

    // Outside the requested visibility reads as absent, not as hidden.
    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  // An unknown categoryId raises P2003, which HttpExceptionFilter maps to 409.
  // The foreign key is the check; a pre-flight lookup would duplicate a
  // database guarantee and introduce a check-then-act race.
  async create(input: CreateProductInput): Promise<ProductWithCategory> {
    return this.prisma.product.create({
      data: input,
      include: { category: true },
    });
  }

  // P2025 on an unknown id propagates and becomes a 404.
  async update(
    id: string,
    input: UpdateProductInput,
  ): Promise<ProductWithCategory> {
    return this.prisma.product.update({
      where: { id },
      data: input,
      include: { category: true },
    });
  }

  /** Soft delete. The row is never removed — historical orders in Phase 3
   *  must keep valid product references. */
  async deactivate(id: string): Promise<void> {
    await this.prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
```

Create `src/modules/products/products.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';

@Module({
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
```

`ProductsModule` deliberately does **not** import `CategoriesModule`: the foreign key enforces category existence and a violation surfaces as `P2003` → 409.

- [ ] **Step 6: Run to verify the tests pass**

```bash
npm test -- src/modules/products/products.service.spec.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 7: Full gate and commit**

```bash
npm run lint:ci && npm run build && npm test
git add src/modules/products
git commit -m "feat: add products service with explicit visibility control"
```

**Tests:** 12 unit tests with a mocked `PrismaService`.

**Verification commands:** Step 6, then the gate in Step 7.

**Definition of Done:** All three visibility values translate correctly; filters and whitelisted sorts translate correctly; pagination and the category join are applied; `findOne` throws `NotFoundException` outside visibility; `deactivate` updates rather than deletes; no Prisma error is caught. Gate green.

**Known risks:**
- *Giving `visibility` a default value* defeats the whole mechanism. It must stay required.
- *Building `orderBy` from a raw string* would reintroduce the injection surface. It is built from an enum-typed field only.
- *`min > max`* yields an empty page by design — not a 400. Do not add a cross-field validator.
- *Ordering by a non-unique column* (`name`, `priceCents`) is not stable across pages. Accepted for Phase 2; do not add an `id` tiebreaker without recording it.

**Out of scope:** No text/name search. No `include` query parameter — the category is always joined. No category existence pre-check. No stock handling. No caching.

---

## Task 6: Public catalog read endpoints

**Objective:** Expose the three `@Public()` catalog reads with explicit response DTOs and full Swagger documentation.

**Dependencies:** Tasks 4 and 5 (and Task 3 for the smoke test).

**Files:**
- Create: `src/modules/categories/dto/category-response.dto.ts`, `src/modules/categories/categories.controller.ts`
- Create: `src/modules/products/dto/product-response.dto.ts`, `src/modules/products/products.controller.ts`
- Modify: `src/modules/categories/categories.module.ts`, `src/modules/products/products.module.ts`, `src/app.module.ts`
- Create: `test/catalog.e2e-spec.ts` (smoke only here; expanded in Task 9)

**Interfaces:**
- Consumes: `CategoriesService`, `ProductsService`, `ProductListQueryDto`, `PaginatedDto.from`, `@ApiPaginatedResponse`.
- Produces: `CategoryResponseDto.from(category: Category)`, `ProductResponseDto.from(product: ProductWithCategory)`.

- [ ] **Step 1: Write the response DTOs**

Create `src/modules/categories/dto/category-response.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { Category } from '@prisma/client';

export class CategoryResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: 'Desks' })
  name!: string;

  @ApiProperty({ example: 'desks' })
  slug!: string;

  @ApiProperty()
  createdAt!: Date;

  // Explicit field-by-field mapping, never a spread. @Exclude() silently does
  // nothing on Prisma's plain objects, so this is the only mechanism that
  // actually prevents field leaks.
  static from(category: Category): CategoryResponseDto {
    const dto = new CategoryResponseDto();

    dto.id = category.id;
    dto.name = category.name;
    dto.slug = category.slug;
    dto.createdAt = category.createdAt;

    return dto;
  }
}
```

Create `src/modules/products/dto/product-response.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { CategoryResponseDto } from '../../categories/dto/category-response.dto';
import { ProductWithCategory } from '../types/product-visibility';

export class ProductResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: 'Desk Lamp' })
  name!: string;

  @ApiProperty({ example: 'An adjustable desk lamp.' })
  description!: string;

  // Integer minor units. Never a decimal example here.
  @ApiProperty({ example: 4999, description: 'Price in minor units' })
  priceCents!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ nullable: true, example: null })
  imageUrl!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000001' })
  categoryId!: string;

  @ApiProperty({ type: CategoryResponseDto })
  category!: CategoryResponseDto;

  @ApiProperty()
  createdAt!: Date;

  static from(product: ProductWithCategory): ProductResponseDto {
    const dto = new ProductResponseDto();

    dto.id = product.id;
    dto.name = product.name;
    dto.description = product.description;
    dto.priceCents = product.priceCents;
    dto.currency = product.currency;
    dto.imageUrl = product.imageUrl;
    dto.isActive = product.isActive;
    dto.categoryId = product.categoryId;
    dto.category = CategoryResponseDto.from(product.category);
    dto.createdAt = product.createdAt;

    return dto;
  }
}
```

- [ ] **Step 2: Write the public categories controller**

Create `src/modules/categories/categories.controller.ts`:

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { CategoryResponseDto } from './dto/category-response.dto';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List catalog categories' })
  @ApiPaginatedResponse(CategoryResponseDto)
  async list(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedDto<CategoryResponseDto>> {
    const { items, total } = await this.categoriesService.list(query);

    return PaginatedDto.from(items.map(CategoryResponseDto.from), total, query);
  }
}
```

- [ ] **Step 3: Write the public products controller**

Create `src/modules/products/products.controller.ts`:

```typescript
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { ProductListQueryDto } from './dto/product-list-query.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List active products' })
  @ApiPaginatedResponse(ProductResponseDto)
  @ApiResponse({ status: 400, description: 'Invalid pagination, filter, or sort value' })
  async list(
    @Query() query: ProductListQueryDto,
  ): Promise<PaginatedDto<ProductResponseDto>> {
    // 'active-only' is passed explicitly on every public read. The service
    // has no default; that is the point.
    const { items, total } = await this.productsService.list(
      query,
      'active-only',
    );

    return PaginatedDto.from(items.map(ProductResponseDto.from), total, query);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one active product' })
  @ApiResponse({ status: 200, description: 'The product' })
  @ApiResponse({
    status: 404,
    description: 'No active product with that id — a deactivated product reads as absent',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProductResponseDto> {
    return ProductResponseDto.from(
      await this.productsService.findOne(id, 'active-only'),
    );
  }
}
```

- [ ] **Step 4: Wire the controllers into their modules**

`src/modules/categories/categories.module.ts`:

```typescript
@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
```

`src/modules/products/products.module.ts`:

```typescript
@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
```

- [ ] **Step 5: Register both modules in `AppModule`**

Add `CategoriesModule` and `ProductsModule` to the `imports` array in `src/app.module.ts`, after `AuthModule`. Do not touch the `providers` array in this task.

- [ ] **Step 6: Write the public catalog smoke e2e**

Create `test/catalog.e2e-spec.ts` (Task 9 expands this file):

```typescript
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { PrismaService } from '../src/prisma/prisma.service';

interface PaginatedBody {
  data: { id: string; name: string; priceCents: number; isActive: boolean }[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

describe('public catalog (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  it('lists active products without a token', async () => {
    const category = await createCategory(prisma);
    await createProduct(prisma, category.id, { name: 'Visible' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(200);

    const body = response.body as PaginatedBody;

    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Visible');
    expect(body.meta.total).toBe(1);
  });

  it('excludes deactivated products from the public list', async () => {
    const category = await createCategory(prisma);
    await createProduct(prisma, category.id, { isActive: false });

    const response = await request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(200);

    expect((response.body as PaginatedBody).data).toHaveLength(0);
  });

  it('returns 404 for a deactivated product on the detail route', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      isActive: false,
    });

    await request(app.getHttpServer())
      .get(`/api/v1/products/${product.id}`)
      .expect(404);
  });

  it('lists categories without a token', async () => {
    await createCategory(prisma, { name: 'Desks', slug: 'desks' });

    const response = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .expect(200);

    expect((response.body as PaginatedBody).meta.total).toBe(1);
  });
});
```

- [ ] **Step 7: Run the smoke suite**

```bash
npm run test:e2e -- test/catalog.e2e-spec.ts
```

Expected: PASS, 4 tests. This is also the first real exercise of both factories from Task 3.

- [ ] **Step 8: Check Swagger renders the paginated schemas**

```bash
npm run start:dev
```

Open `http://localhost:3000/api/docs` and confirm: `products` and `categories` tags appear; `GET /api/v1/products` documents `page`, `limit`, `categoryId`, `minPriceCents`, `maxPriceCents`, `sort` (three enum values), `order`; the response schema shows `data` + `meta`; the price example reads `4999`, not `49.99`. Then stop the server.

- [ ] **Step 9: Full gate and commit**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
git add src/modules/categories src/modules/products src/app.module.ts test/catalog.e2e-spec.ts
git commit -m "feat: add public catalog read endpoints"
```

**Tests:** 4 e2e tests (no new unit tests — controllers are thin and covered end to end).

**Verification commands:** Steps 7, 8, 9.

**Definition of Done:** Three public routes live under `/api/v1`, all `@Public()`; deactivated products excluded from the list and 404 on detail; responses use explicit DTO mappers; Swagger documents parameters, enums, and integer money; both factories exercised. Full gate green.

**Known risks:**
- *Forgetting `@Public()`* makes the catalog require a token — the smoke tests catch it immediately.
- *Returning Prisma objects directly* would leak fields silently. The mappers are mandatory.
- *`ParseUUIDPipe` returns 400 for a non-UUID id*, not 404. That is correct and intended; Task 9 pins the 404 case with a well-formed but unknown UUID.

**Out of scope:** No admin routes, no writes, no `status` filter — those are Task 7. No `@Roles()` anywhere in this task.

---

## Task 7: Admin write endpoints

**Objective:** Add the admin catalog surface behind class-level `@Roles(Role.ADMIN)`.

**Dependencies:** Task 2 (guard and a reachable ADMIN), Tasks 5 and 6 (services and response DTOs).

**Files:**
- Create: `src/modules/products/dto/create-product.dto.ts`, `src/modules/products/dto/update-product.dto.ts`, `src/modules/products/dto/admin-product-list-query.dto.ts`, `src/modules/products/admin-products.controller.ts`
- Create: `src/modules/categories/dto/create-category.dto.ts`, `src/modules/categories/dto/update-category.dto.ts`, `src/modules/categories/admin-categories.controller.ts`
- Modify: `src/modules/products/products.module.ts`, `src/modules/categories/categories.module.ts`

**Interfaces:**
- Consumes: `ProductsService`, `CategoriesService`, `ProductResponseDto`, `CategoryResponseDto`, `@Roles`, `ProductVisibility`.
- Produces: the six admin routes listed in spec §7.2.

- [ ] **Step 1: Write the request DTOs**

Create `src/modules/products/dto/create-product.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUppercase,
  IsUrl,
  IsUUID,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ example: 'Desk Lamp' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'An adjustable desk lamp.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  // Integer minor units. enableImplicitConversion is false, so @Type is
  // required for the value to arrive as a number at all.
  @ApiProperty({ example: 4999, description: 'Price in minor units' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceCents!: number;

  @ApiPropertyOptional({ example: 'USD', default: 'USD' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @IsUppercase()
  currency?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/lamp.png' })
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  imageUrl?: string;

  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000001' })
  @IsUUID()
  categoryId!: string;
}
```

Create `src/modules/products/dto/update-product.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUppercase,
  IsUrl,
  IsUUID,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Written out in full rather than via PartialType(CreateProductDto), because
 * it carries one field CreateProductDto does not: isActive, which is how a
 * deactivated product is restored.
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Desk Lamp' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'An adjustable desk lamp.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: 4999, description: 'Price in minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceCents?: number;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @IsUppercase()
  currency?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/lamp.png' })
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  imageUrl?: string;

  @ApiPropertyOptional({ example: '0195f0a0-0000-7000-8000-000000000001' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Set true to restore a deactivated product',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
```

Create `src/modules/products/dto/admin-product-list-query.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { ProductListQueryDto } from './product-list-query.dto';

export enum ProductStatusFilter {
  Active = 'active',
  Inactive = 'inactive',
  All = 'all',
}

export class AdminProductListQueryDto extends ProductListQueryDto {
  @ApiPropertyOptional({
    enum: ProductStatusFilter,
    default: ProductStatusFilter.All,
  })
  @IsEnum(ProductStatusFilter)
  status: ProductStatusFilter = ProductStatusFilter.All;
}
```

Create `src/modules/categories/dto/create-category.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateCategoryDto {
  @ApiProperty({ example: 'Desks' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  // Client-supplied, not derived: automatic slugification needs a
  // transliteration policy and a collision strategy, both of which are
  // invisible complexity for a field an operator can type.
  @ApiProperty({ example: 'desks', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
  @IsString()
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric words separated by hyphens',
  })
  slug!: string;
}
```

Create `src/modules/categories/dto/update-category.dto.ts` with the same two fields, each `@IsOptional()` and typed `?:`.

- [ ] **Step 2: Write the admin products controller**

Create `src/modules/products/admin-products.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ProductsService } from './products.service';
import {
  AdminProductListQueryDto,
  ProductStatusFilter,
} from './dto/admin-product-list-query.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { ProductVisibility } from './types/product-visibility';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

const VISIBILITY_BY_STATUS: Record<ProductStatusFilter, ProductVisibility> = {
  [ProductStatusFilter.Active]: 'active-only',
  [ProductStatusFilter.Inactive]: 'inactive-only',
  [ProductStatusFilter.All]: 'all',
};

/**
 * Every route here is admin-only through ONE class-level decorator. That is
 * the point of the split controller: the likeliest authorization defect in
 * this phase is a write route that forgets @Roles(), and a class-level
 * decorator turns six chances to forget into one.
 */
@ApiTags('admin-products')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({
    summary: 'List products, including deactivated ones',
    description:
      'The only route through which a deactivated product can be found: the public list excludes it and the public detail route returns 404.',
  })
  @ApiPaginatedResponse(ProductResponseDto)
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an administrator' })
  async list(
    @Query() query: AdminProductListQueryDto,
  ): Promise<PaginatedDto<ProductResponseDto>> {
    const { items, total } = await this.productsService.list(
      query,
      VISIBILITY_BY_STATUS[query.status],
    );

    return PaginatedDto.from(items.map(ProductResponseDto.from), total, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a product' })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an administrator' })
  @ApiResponse({ status: 409, description: 'categoryId does not reference an existing category' })
  async create(@Body() dto: CreateProductDto): Promise<ProductResponseDto> {
    return ProductResponseDto.from(
      await this.productsService.create({
        name: dto.name,
        description: dto.description,
        priceCents: dto.priceCents,
        currency: dto.currency ?? 'USD',
        imageUrl: dto.imageUrl,
        categoryId: dto.categoryId,
      }),
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a product',
    description: 'Send { "isActive": true } to restore a deactivated product.',
  })
  @ApiResponse({ status: 200, description: 'Updated' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an administrator' })
  @ApiResponse({ status: 404, description: 'No product with that id' })
  @ApiResponse({ status: 409, description: 'categoryId does not reference an existing category' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductResponseDto> {
    return ProductResponseDto.from(await this.productsService.update(id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deactivate a product (soft delete)',
    description:
      'Sets isActive to false. The row is never removed, so historical orders keep valid product references. Restore with PATCH { "isActive": true }.',
  })
  @ApiResponse({ status: 204, description: 'Deactivated' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an administrator' })
  @ApiResponse({ status: 404, description: 'No product with that id' })
  async deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.productsService.deactivate(id);
  }
}
```

- [ ] **Step 3: Write the admin categories controller**

Create `src/modules/categories/admin-categories.controller.ts` with the same shape: `@ApiTags('admin-categories')`, `@ApiBearerAuth()`, `@Roles(Role.ADMIN)`, `@Controller('admin/categories')`, and two routes:

```typescript
  @Post()
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an administrator' })
  @ApiResponse({ status: 409, description: 'name or slug already exists' })
  async create(@Body() dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    return CategoryResponseDto.from(
      await this.categoriesService.create({ name: dto.name, slug: dto.slug }),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a category' })
  @ApiResponse({ status: 200, description: 'Updated' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an administrator' })
  @ApiResponse({ status: 404, description: 'No category with that id' })
  @ApiResponse({ status: 409, description: 'name or slug already exists' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return CategoryResponseDto.from(
      await this.categoriesService.update(id, dto),
    );
  }
```

- [ ] **Step 4: Register both controllers**

Add `AdminProductsController` to `ProductsModule.controllers` and `AdminCategoriesController` to `CategoriesModule.controllers`. `AppModule` needs no change — the modules are already imported.

- [ ] **Step 5: Verify the routes exist and are guarded**

```bash
npm run build
npm run test:e2e -- test/roles-guard.e2e-spec.ts
```

Then a quick manual check that the routes are mounted:

```bash
npm run start:dev
```

Confirm in the startup log that `AdminProductsController {/api/v1/admin/products}` and `AdminCategoriesController {/api/v1/admin/categories}` are mapped, then stop the server. Full behaviour is asserted in Task 9.

- [ ] **Step 6: Full gate and commit**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
git add src/modules/products src/modules/categories
git commit -m "feat: add admin catalog write endpoints behind RolesGuard"
```

**Tests:** No new tests in this task — the behaviour they would assert is the Task 9 authorization matrix, which tests all six routes uniformly rather than piecemeal. Task 7 must not be considered done independently of Task 9.

**Verification commands:** Step 5, then the gate in Step 6.

**Definition of Done:** Six admin routes mounted under `/api/v1/admin/*`; each controller carries a single class-level `@Roles(Role.ADMIN)` and `@ApiBearerAuth()`; every route documents 401 **and** 403; `DELETE` returns 204 and deactivates; `PATCH` accepts `isActive`; money examples are integers. Gate green.

**Known risks:**
- *Adding a per-method `@Roles()` instead of class-level* reintroduces the omission risk the split controller exists to remove.
- *Documenting only 403 and not 401* hides half the authorization contract.
- *`PartialType()` for the update DTO* would drop `isActive`; the DTO is written out in full for that reason.
- *Defaulting `currency` in two places.* It is defaulted once, in the controller (`?? 'USD'`), and once in the schema. Keep them the same string.

**Out of scope:** No category delete route. No admin product detail route (`PATCH` returns the entity; the admin list finds inactive products). No bulk operations. No `@Roles()` on any public route.

---

## Task 8: Pagination contract — fit assessment

**Objective:** Carry out the assessment Phase 1 spec §11 requires, and record the outcome. Change the shared primitives **only** if the real product list proves a need.

**Dependencies:** Task 6 (a real list endpoint must exist before it can be assessed).

**Files:**
- Modify (only if a change is proven): `src/common/dto/pagination-query.dto.ts`, `src/common/dto/paginated.dto.ts`, `src/common/swagger/api-paginated-response.decorator.ts`, and the corresponding spec files, and `docs/superpowers/specs/2026-08-12-foundation-architecture-design.md`
- Modify (always): `docs/superpowers/specs/2026-08-31-phase-2-products-design.md` §8.2 — record the outcome

**Interfaces:** None new. This task either changes an existing contract explicitly or confirms it unchanged.

- [ ] **Step 1: Run the assessment against the shipped endpoints**

Answer each question against the code as it now stands, writing the answers down:

1. Did `ProductListQueryDto extends PaginationQueryDto` work without modifying the base class? (Check: does `whitelist`/`forbidNonWhitelisted` accept the inherited `page`/`limit` alongside the subclass fields? Task 6's e2e already proves this at runtime.)
2. Did `PaginatedDto.from(items, total, query)` accept the service output unchanged?
3. Did `@ApiPaginatedResponse(ProductResponseDto)` render a correct schema? (Verified visually in Task 6 Step 8.)
4. Did anything require a workaround **at the endpoint** to preserve the DTO's shape? If yes, that is the signal to change the DTO instead.

- [ ] **Step 2: Take the branch that matches the evidence**

**Branch A — no change needed (the expected outcome).** Record it in the Phase 2 spec §8.2 by appending:

```markdown
**Outcome, confirmed 2026-09-01 against the shipped endpoints:** no reshape was
required. `ProductListQueryDto extends PaginationQueryDto` carried the filters
and sort without modifying the base class; `PaginatedDto.from` accepted the
service output unchanged; `@ApiPaginatedResponse` rendered correctly for both
`ProductResponseDto` and `CategoryResponseDto`. No endpoint was contorted to
preserve a primitive's shape. The primitives are now proven by real consumers
rather than by unit tests alone.
```

Commit as a docs-only change.

**Branch B — a change is proven necessary.** Then, in one commit:
1. Change the primitive and its unit tests.
2. Update **every** consumer (`ProductsController`, `CategoriesController`, `AdminProductsController`).
3. Amend Phase 2 spec §8.2 stating what changed and what evidence forced it.
4. If the change alters the offset/page contract itself, **also amend foundation spec §5**, which chose offset deliberately — that is a spec change, not a silent DTO edit.
5. Re-run the full gate.

- [ ] **Step 3: Verify nothing regressed**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 4: Commit**

Branch A:
```bash
git add docs/superpowers/specs/2026-08-31-phase-2-products-design.md
git commit -m "docs: record the pagination primitive fit assessment"
```

Branch B:
```bash
git add src/common docs/superpowers/specs
git commit -m "refactor: reshape pagination primitives for the product list contract"
```

**Tests:** Branch A adds none. Branch B updates the existing `paginated.dto.spec.ts` / `pagination-query.dto.spec.ts` to match the new contract.

**Verification commands:** Step 3.

**Definition of Done:** The assessment is written down in the Phase 2 spec with its evidence. If any `common/` primitive changed, every consumer was updated in the same commit and the foundation spec was amended if the change touched the offset contract. Gate green.

**Known risks:**
- *Speculative redesign.* The instruction is to change the DTO **only** if the real contract proved a need. "It would be nicer if" is not evidence.
- *Silent contract drift.* Changing offset semantics without amending foundation spec §5 leaves two documents disagreeing about a shared decision.

**Out of scope:** Cursor pagination. Sort-by-multiple-fields. A generic filter framework. Anything not forced by the product list that now exists.

---

## Task 9: Full catalog and authorization e2e

**Objective:** Prove the whole phase behaves as specified, with the authorization matrix asserted **per route**.

**Dependencies:** Tasks 6 and 7.

**Files:**
- Modify: `test/catalog.e2e-spec.ts` (expand the Task 6 smoke suite)
- Create: `test/catalog-admin.e2e-spec.ts`

**Interfaces:** Consumes every route shipped in Tasks 6 and 7, plus `createUser`, `createCategory`, `createProduct`.

- [ ] **Step 1: Expand the public catalog suite**

Add to `test/catalog.e2e-spec.ts`:

```typescript
  it('reports correct pagination metadata across pages', async () => {
    const category = await createCategory(prisma);

    for (let i = 0; i < 25; i += 1) {
      await createProduct(prisma, category.id);
    }

    const first = await request(app.getHttpServer())
      .get('/api/v1/products?page=1&limit=10')
      .expect(200);

    expect((first.body as PaginatedBody).meta).toEqual({
      page: 1,
      limit: 10,
      total: 25,
      totalPages: 3,
    });
    expect((first.body as PaginatedBody).data).toHaveLength(10);

    const last = await request(app.getHttpServer())
      .get('/api/v1/products?page=3&limit=10')
      .expect(200);

    expect((last.body as PaginatedBody).data).toHaveLength(5);
  });

  it('rejects a limit above the maximum', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/products?limit=101')
      .expect(400);
  });

  it('filters by category', async () => {
    const wanted = await createCategory(prisma);
    const other = await createCategory(prisma);

    await createProduct(prisma, wanted.id, { name: 'Wanted' });
    await createProduct(prisma, other.id, { name: 'Other' });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/products?categoryId=${wanted.id}`)
      .expect(200);

    const body = response.body as PaginatedBody;

    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Wanted');
  });

  it('filters by price range in minor units', async () => {
    const category = await createCategory(prisma);

    await createProduct(prisma, category.id, { priceCents: 500 });
    await createProduct(prisma, category.id, { priceCents: 5000 });
    await createProduct(prisma, category.id, { priceCents: 50000 });

    const response = await request(app.getHttpServer())
      .get('/api/v1/products?minPriceCents=1000&maxPriceCents=10000')
      .expect(200);

    const body = response.body as PaginatedBody;

    expect(body.data).toHaveLength(1);
    expect(body.data[0].priceCents).toBe(5000);
  });

  it('sorts by a whitelisted field', async () => {
    const category = await createCategory(prisma);

    await createProduct(prisma, category.id, { priceCents: 300 });
    await createProduct(prisma, category.id, { priceCents: 100 });
    await createProduct(prisma, category.id, { priceCents: 200 });

    const response = await request(app.getHttpServer())
      .get('/api/v1/products?sort=priceCents&order=asc')
      .expect(200);

    expect(
      (response.body as PaginatedBody).data.map((p) => p.priceCents),
    ).toEqual([100, 200, 300]);
  });

  it('rejects a sort field outside the whitelist with 400', async () => {
    // The enum plus @IsEnum stops this at the ValidationPipe. It must never
    // reach Prisma as an orderBy key.
    await request(app.getHttpServer())
      .get('/api/v1/products?sort=passwordHash')
      .expect(400);
  });

  it('returns 404 for a well-formed but unknown product id', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/products/0195f0a0-0000-7000-8000-0000000000ff')
      .expect(404);
  });

  it('never exposes a floating-point price', async () => {
    const category = await createCategory(prisma);

    await createProduct(prisma, category.id, { priceCents: 4999 });

    const response = await request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(200);

    const price = (response.body as PaginatedBody).data[0].priceCents;

    expect(Number.isInteger(price)).toBe(true);
  });
```

- [ ] **Step 2: Write the admin authorization suite**

Create `test/catalog-admin.e2e-spec.ts`:

```typescript
import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser, TEST_PASSWORD } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { PrismaService } from '../src/prisma/prisma.service';

interface AuthBody {
  accessToken: string;
}

interface ProductBody {
  id: string;
  isActive: boolean;
  priceCents: number;
}

interface PaginatedBody {
  data: ProductBody[];
  meta: { total: number };
}

describe('admin catalog (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let customerToken: string;
  let categoryId: string;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

    return (response.body as AuthBody).accessToken;
  };

  beforeEach(async () => {
    await truncateAll(prisma);

    const admin = await createUser(prisma, { role: Role.ADMIN });
    const customer = await createUser(prisma, { role: Role.CUSTOMER });

    adminToken = await login(admin.email);
    customerToken = await login(customer.email);
    categoryId = (await createCategory(prisma)).id;
  });

  const validProduct = () => ({
    name: 'Desk Lamp',
    description: 'An adjustable desk lamp.',
    priceCents: 4999,
    categoryId,
  });

  describe('authorization matrix', () => {
    // Asserted per route, not once representatively: "default-deny" protects
    // against unauthenticated callers, not under-privileged ones, so a route
    // that forgot @Roles() would still pass a single representative test.
    const routes: {
      name: string;
      call: (token?: string) => request.Test;
      adminExpects: number;
    }[] = [
      {
        name: 'GET /admin/products',
        call: (token) => {
          const r = request(app.getHttpServer()).get('/api/v1/admin/products');
          return token ? r.set('Authorization', `Bearer ${token}`) : r;
        },
        adminExpects: 200,
      },
      {
        name: 'POST /admin/products',
        call: (token) => {
          const r = request(app.getHttpServer())
            .post('/api/v1/admin/products')
            .send(validProduct());
          return token ? r.set('Authorization', `Bearer ${token}`) : r;
        },
        adminExpects: 201,
      },
      {
        name: 'POST /admin/categories',
        call: (token) => {
          const r = request(app.getHttpServer())
            .post('/api/v1/admin/categories')
            .send({ name: 'Chairs', slug: 'chairs' });
          return token ? r.set('Authorization', `Bearer ${token}`) : r;
        },
        adminExpects: 201,
      },
    ];

    for (const route of routes) {
      it(`${route.name} rejects an unauthenticated caller with 401`, async () => {
        await route.call().expect(401);
      });

      it(`${route.name} rejects a CUSTOMER with 403`, async () => {
        await route.call(customerToken).expect(403);
      });

      it(`${route.name} allows an ADMIN`, async () => {
        await route.call(adminToken).expect(route.adminExpects);
      });
    }

    it('PATCH /admin/products/:id enforces the same matrix', async () => {
      const product = await createProduct(prisma, categoryId);
      const url = `/api/v1/admin/products/${product.id}`;

      await request(app.getHttpServer()).patch(url).send({ name: 'X' }).expect(401);
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ name: 'X' })
        .expect(403);
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'X' })
        .expect(200);
    });

    it('DELETE /admin/products/:id enforces the same matrix', async () => {
      const product = await createProduct(prisma, categoryId);
      const url = `/api/v1/admin/products/${product.id}`;

      await request(app.getHttpServer()).delete(url).expect(401);
      await request(app.getHttpServer())
        .delete(url)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .delete(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);
    });

    it('PATCH /admin/categories/:id enforces the same matrix', async () => {
      const url = `/api/v1/admin/categories/${categoryId}`;

      await request(app.getHttpServer()).patch(url).send({ name: 'X' }).expect(401);
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ name: 'X' })
        .expect(403);
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'X' })
        .expect(200);
    });
  });

  describe('error mapping', () => {
    it('returns 409 for a duplicate category name', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Chairs', slug: 'chairs' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Chairs', slug: 'chairs-2' })
        .expect(409);
    });

    it('returns 409 for a duplicate category slug', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Chairs', slug: 'chairs' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Stools', slug: 'chairs' })
        .expect(409);
    });

    it('returns 409 for a product referencing an unknown category', async () => {
      // The first time P2003 reaches HttpExceptionFilter from a real request.
      // It has been unit-tested since Phase F and never triggered.
      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          ...validProduct(),
          categoryId: '0195f0a0-0000-7000-8000-0000000000ff',
        })
        .expect(409);
    });

    it('returns 404 when updating an unknown product', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/0195f0a0-0000-7000-8000-0000000000ff')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'X' })
        .expect(404);
    });

    it('rejects a floating-point price with 400', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validProduct(), priceCents: 49.99 })
        .expect(400);
    });
  });

  describe('deactivation and restoration', () => {
    it('hides a deactivated product publicly but keeps it visible to an admin', async () => {
      const product = await createProduct(prisma, categoryId);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/v1/products/${product.id}`)
        .expect(404);

      const publicList = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);

      expect((publicList.body as PaginatedBody).meta.total).toBe(0);

      const adminList = await request(app.getHttpServer())
        .get('/api/v1/admin/products?status=inactive')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((adminList.body as PaginatedBody).data).toHaveLength(1);
      expect((adminList.body as PaginatedBody).data[0].id).toBe(product.id);
    });

    it('restores a deactivated product through PATCH', async () => {
      const product = await createProduct(prisma, categoryId);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: true })
        .expect(200);

      await request(app.getHttpServer())
        .get(`/api/v1/products/${product.id}`)
        .expect(200);
    });

    it('keeps the row after deactivation — it is a soft delete', async () => {
      const product = await createProduct(prisma, categoryId);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      const row = await prisma.product.findUnique({
        where: { id: product.id },
      });

      expect(row).not.toBeNull();
      expect(row?.isActive).toBe(false);
    });
  });
});
```

- [ ] **Step 3: Run both suites**

```bash
npm run test:e2e -- test/catalog.e2e-spec.ts test/catalog-admin.e2e-spec.ts
```

Expected: PASS. **12 in `catalog`** (4 from Task 6 + 8 added here) and **20 in `catalog-admin`** (9 from the three-route loop + 3 explicit route matrices + 5 error mapping + 3 deactivation).

- [ ] **Step 4: Run the whole e2e suite**

```bash
npm run test:e2e
```

Expected: all suites pass. If `catalog-admin` 429s, `{ throttleLimit: 1000 }` is missing from `createTestApp()` — that is the cause, not an auth defect.

- [ ] **Step 5: Full gate and commit**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
git add test/catalog.e2e-spec.ts test/catalog-admin.e2e-spec.ts
git commit -m "test: add catalog and authorization end-to-end coverage"
```

**Tests:** 28 new e2e tests — 8 added to `catalog.e2e-spec.ts`, 20 in `catalog-admin.e2e-spec.ts`.

**Verification commands:** Steps 3–5.

**Definition of Done:** Every one of the six admin routes asserts 401 / 403 / 2xx. Duplicate name → 409; duplicate slug → 409; unknown category FK → 409 (first real `P2003`); unknown id → 404 (first real `P2025` from a request); inactive excluded from the public list; inactive → 404 on public detail; inactive visible via the admin list; restoration works; soft delete keeps the row; pagination metadata verified across pages; unlisted sort → 400. Full gate green.

**Known risks:**
- *Throttling.* Heavy suite — `{ throttleLimit: 1000 }` is required.
- *Fixed category names in a suite that does not truncate.* `beforeEach` truncates; keep it.
- *Sequential factory names collide across spec files* if truncation is removed. Do not remove it.
- *Testing 403 on one route and assuming the rest.* The matrix is per route by design.

**Out of scope:** Load or performance testing. Concurrency tests (Phase 3's checkout is where that matters). Swagger snapshot tests.

---

## Task 10: Documentation and final review

**Objective:** Record the Phase 2 conventions, update the README, and run the full phase gate.

**Dependencies:** Tasks 1–9.

**Files:**
- Modify: `CLAUDE.md`, `README.md`
- Verify unchanged: `docs/deferred-limitations.md`

- [ ] **Step 1: Add the Phase 2 section to `CLAUDE.md`**

Insert after the Phase 1 authentication section, matching its tone — record only the non-obvious invariants a future reader would otherwise break silently:

```markdown
### Products and authorization (Phase 2 — implemented)

- **`RolesGuard` is opt-in; `JwtAuthGuard` is opt-out.** A route with no
  `@Roles()` is reachable by any authenticated caller. This asymmetry is
  deliberate: authentication has a safe universal default, authorization does
  not — a fail-closed roles guard would need an invented required role for
  every route, including the public catalog. The mitigation is structural: all
  admin routes live on controllers carrying a single class-level
  `@Roles(Role.ADMIN)`, and every write route asserts 403 in e2e.
- **Guard order is `ThrottlerGuard → JwtAuthGuard → RolesGuard`** and is
  registration-order dependent in `AppModule`. `RolesGuard` reads
  `request.user`, which `JwtAuthGuard` populates; reversing them turns a 401
  into a misleading 403. `RolesGuard` is registered under its own class token
  and aliased with `useExisting`, like `JwtAuthGuard`, so
  `overrideProvider()` can target it — `overrideGuard()` silently no-ops.
- **`@Roles()` lives in `common/decorators/`, `RolesGuard` in
  `modules/auth/guards/`.** The decorator is dependency-free metadata; the
  guard consumes `AuthenticatedUser`, so placing it in `common/` would make
  the cross-cutting layer depend on a feature module.
- **`ProductsService` read methods take a required `visibility` argument.**
  Never give it a default. A caller that forgets it must fail to compile —
  the failure being guarded against is a future phase quietly reading
  deactivated products into an order, which a safe default would hide.
  The public detail route returns **404** for an inactive product: outside the
  requested visibility reads as absent, not as hidden.
- **`Product.category` is `onDelete: Restrict`, never `Cascade`.** Deleting a
  category must not delete its products; the FK violation surfaces as `P2003`
  → 409. Category deletion is deliberately not implemented — it needs an
  orphan policy.
- **Sort fields are a whitelist enum validated by `@IsEnum`.** An unlisted
  value is rejected with 400 by the global pipe and never reaches Prisma as an
  `orderBy` key. Do not accept a free-form sort string.
- **`UsersService.ensureAdmin()` never rewrites an existing `passwordHash`.**
  It creates, promotes, or does nothing. Promotion and password reset are
  different operations and only the first ships. `CreateUserInput` still has
  no `role` field — registration cannot mint an ADMIN, and that stays true.
- **The admin bootstrap is a compiled script, not a Prisma seed.** The runtime
  image installs with `--omit=dev`, so neither the `prisma` CLI nor `ts-node`
  exists there; `node dist/scripts/bootstrap-admin.js` runs with zero extra
  dependencies. It reads config through `ConfigService`, so `src/config/`
  remains the only reader of `process.env`. CI runs the compiled command twice
  and diffs `password_hash` across runs.
```

- [ ] **Step 2: Update `README.md`**

1. Add the six new routes to the existing API table, marking the three public catalog reads as `public` and the admin routes as `Bearer (ADMIN)`.
2. Add a bootstrap section:

````markdown
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
````

3. Move the project-status line to Phase 3 and tick Products.

- [ ] **Step 3: Verify the deferred-limitations file is untouched**

```bash
git diff HEAD~9 --stat -- docs/deferred-limitations.md
```

Expected: **no output**. If the file changed in any commit this phase, revert that hunk — entries are closed by shipping a fix and saying so, never by editing them in passing, and Phase 2 closes none.

- [ ] **Step 4: Run the complete phase gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Expected: lint clean; build clean; **138 unit tests** (104 baseline + 18 from Task 2 + 4 from Task 4 + 12 from Task 5); **75 e2e tests** (35 baseline + 8 from Task 2 + 4 from Task 6 + 28 from Task 9). If the actual counts differ, stop and find out why before committing — a missing test is easier to spot here than later.

- [ ] **Step 5: Verify the Definition of Done for the phase**

Walk spec §15 item by item and confirm each. In particular, re-read §15 item 4 and confirm `test/bootstrap-admin.e2e-spec.ts` imports no factory:

```bash
grep -n "factories" test/bootstrap-admin.e2e-spec.ts
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: record Phase 2 products and authorization conventions"
```

**Tests:** None. Documentation only.

**Verification commands:** Steps 3–5.

**Definition of Done:** `CLAUDE.md` records the eight Phase 2 invariants; `README.md` documents the routes and the bootstrap command exactly as CI runs it; `docs/deferred-limitations.md` is byte-identical to its state at the start of the phase; the full gate passes; spec §15 verified item by item.

**Known risks:**
- *README documenting a command CI does not run* (or vice versa) breaks the guarantee that CI tests the operator's path. Both must read `node dist/scripts/bootstrap-admin.js`.
- *Deleting a deferred-limitations entry* because it "feels handled". Phase 2 closes none.

**Out of scope:** Phase 3 planning. Architecture diagrams. Changelog.

---

## Plan Self-Review

Performed after writing, against `docs/superpowers/specs/2026-08-31-phase-2-products-design.md`.

**Spec coverage:** §5.1/§5.2 → Task 1. §5.3 indexes and `Restrict` → Task 1 Steps 1, 3, 4. §5.4 money → Tasks 1, 5, 7, 9. §5.5/§7.3 soft delete → Tasks 5, 7, 9. §5.6 image → Task 7 DTOs. §6.1/§6.2/§6.3 guard → Task 2. §6.4 matrix → Task 9. §7.1 public routes → Task 6. §7.2 admin routes → Task 7. §7.4 DTO mappers → Task 6. §8 list contract → Task 5 DTO + Task 9 assertions. §8.2 fit assessment → Task 8. §9.1 modules → Tasks 4–7. §9.2 visibility → Task 5. §9.3 error mapping → Task 9. §9.4 slug → Task 7 DTO. §10 Swagger → Tasks 6, 7. §11 tests → Tasks 2, 4, 5, 6, 9. §12 order → this plan's task order. §14 → Task 10 Step 3. §17.15 CI → Task 2 Step 22.

**Placeholder scan:** none. Every code step carries runnable code; every verification step carries a command and an expected result.

**Type consistency:** `ProductVisibility`, `ProductWithCategory`, `ProductSortField`, `SortOrder`, `ProductStatusFilter`, `EnsureAdminResult`, `bootstrapAdmin`, `CategoryResponseDto.from`, `ProductResponseDto.from` are each defined in exactly one task and referenced with identical names and signatures thereafter. `ProductsService.list/findOne` carry `visibility` as the second positional argument at every call site.

**Known gap carried deliberately:** Task 7 ships no tests of its own; its behaviour is asserted in Task 9. The two tasks must land in sequence, and Task 7 is not "done" as a phase deliverable until Task 9 is green. This is stated in Task 7's Tests section.
