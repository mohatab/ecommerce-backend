# Phase 1 — Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship registration, login, refresh-with-rotation, logout, and `GET /auth/me` behind a global fail-closed JWT guard, on the first real migration this project has ever committed.

**Architecture:** `UsersModule` owns the `User` model and exports `UsersService` with no controller. `AuthModule` owns `RefreshToken`, hashing, tokens, and the guard, and depends on `UsersService`. Auth logic is split across three focused services — `TokenService` (pure crypto/JWT, no database), `RefreshTokenService` (persistence, rotation, family revocation), and `AuthService` (orchestration) — so each is unit-testable in isolation. `JwtAuthGuard` is registered globally via `APP_GUARD` and fails closed; routes opt out with `@Public()`.

**Tech Stack:** NestJS 11, Prisma 6.19.3, PostgreSQL 16, `@nestjs/jwt` 11.0.2, `@nestjs/throttler` 6.5.0, `@node-rs/argon2` 2.0.2, Jest 30 + Supertest, TypeScript 5.7 (strict).

**Spec:** `docs/superpowers/specs/2026-08-13-phase-1-authentication-design.md`
**Branch:** `phase-1/authentication`

## Global Constraints

- **Strict TypeScript.** `strict: true`, `noUnusedLocals`, `noUnusedParameters`. Avoid `any`; if unavoidable, comment why. Public methods have explicit return types.
- **`src/config/` is the only place in `src/` that reads `process.env`.** `test/` is exempt.
- **Every new env var** goes into `.env.example` *and* the Joi schema in `src/config/env.validation.ts` **in the same commit**.
- **Argon2id for passwords. SHA-256 for tokens.** Never the reverse. See spec §4.2.
- **Controllers never return Prisma objects.** Every response DTO defines a static `from()` mapper — `@Exclude()` silently no-ops on Prisma's plain objects.
- **Passwords and tokens are never logged** at any level.
- **`test/factories/` inserts via the Prisma client, never `$executeRaw`/`$queryRaw`** — `uuid(7)` is generated client-side and the column has no database default.
- **The e2e suite is serial** (`maxWorkers: 1`). Never assume worker isolation; never raise it.
- **`RolesGuard` is NOT built in this phase.** The `Role` column ships; the guard waits for Phase 2. See spec §7.
- **Before any task is done:** `npm run lint`, `npm run build`, `npm test` must pass. `npm run test:e2e` additionally for anything DB-dependent.
- **Prerequisite:** `docker compose up -d` (dev on 5432, test on 5433).

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/modules/users/users.service.ts` | `findByEmail`, `findById`, `create` — the only place `User` rows are read/written |
| `src/modules/users/users.module.ts` | Exports `UsersService`; no controller |
| `src/modules/auth/password-hasher.service.ts` | Argon2id hash/verify — wraps `@node-rs/argon2` so the library is swappable in one file |
| `src/modules/auth/token.service.ts` | JWT sign/verify, refresh-token generation, SHA-256 hashing. **No database access.** |
| `src/modules/auth/refresh-token.service.ts` | Refresh-token persistence: issue, rotate, detect reuse, revoke family |
| `src/modules/auth/auth.service.ts` | Orchestrates register / login / refresh / logout |
| `src/modules/auth/auth.controller.ts` | The five auth routes |
| `src/modules/auth/auth.module.ts` | Wires the above; exports `JwtAuthGuard` |
| `src/modules/auth/decorators/public.decorator.ts` | `@Public()` opt-out marker |
| `src/modules/auth/guards/jwt-auth.guard.ts` | Global fail-closed guard |
| `src/modules/auth/dto/register.dto.ts` | Validated registration input |
| `src/modules/auth/dto/login.dto.ts` | Validated login input |
| `src/modules/auth/dto/refresh.dto.ts` | Validated refresh input |
| `src/modules/auth/dto/user-response.dto.ts` | `UserResponseDto.from()` — never leaks `passwordHash` |
| `src/modules/auth/dto/auth-response.dto.ts` | `{ accessToken, refreshToken, user }` |
| `src/modules/auth/types/authenticated-user.ts` | Access-token payload shape + Express `Request` augmentation |
| `test/factories/user.factory.ts` | `createUser()` via the Prisma client |
| `test/auth.e2e-spec.ts` | Full auth flow coverage |
| `test/auth-guard.e2e-spec.ts` | The mandatory 401 regression test |
| `prisma/migrations/<ts>_add_user_and_refresh_token/` | First committed migration |

**Modified:**

| File | Change |
|---|---|
| `prisma/schema.prisma` | Adds `Role`, `User`, `RefreshToken` |
| `src/config/env.validation.ts` | Adds `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` |
| `src/config/configuration.ts` | Adds the `jwt` block to `AppConfig` |
| `.env.example` | Same three vars |
| `src/app.module.ts` | Imports `AuthModule`/`ThrottlerModule`; registers both `APP_GUARD`s in order |
| `src/modules/health/health.controller.ts` | Adds `@Public()` — otherwise `/health` starts returning 401 |
| `test/fixtures/ping.module.ts` | Adds `@Public()` — otherwise `routing.e2e-spec.ts` breaks |
| `package.json` | Adds three dependencies |
| `CLAUDE.md`, `README.md` | Records conventions |

**Ordering note.** Spec §12 lists factories third and the password hasher fifth. This plan swaps them: the factory needs a real Argon2id digest as its `TEST_PASSWORD_HASH` constant, and generating one requires the library to already be installed. Everything else follows the spec's order.

**⚠️ Two existing files break the moment the global guard lands (Task 9).** `/health` and the `PingController` fixture are currently unauthenticated; a fail-closed guard returns 401 for both, which breaks `app.e2e-spec.ts` and all of `routing.e2e-spec.ts`. Task 9 fixes both in the same commit as the guard. This is the guard working correctly, not a regression.

---

## Task 1: Configuration for JWT secrets and lifetimes

Goes first so every later task can read `jwt.*` from `ConfigService` instead of inventing its own access.

**Files:**
- Modify: `.env.example`
- Modify: `src/config/env.validation.ts`
- Modify: `src/config/configuration.ts`
- Test: `src/config/configuration.spec.ts` (create)

**Interfaces:**
- Produces: `AppConfig['jwt']` — `{ secret: string; accessTtl: string; refreshTtl: string }`, read via `configService.get('jwt.secret', { infer: true })`.

- [ ] **Step 1: Write the failing test**

Create `src/config/configuration.spec.ts`. It pins the mapping from environment to typed config, including the defaults.

```ts
import configuration from './configuration';

describe('configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('maps JWT settings from the environment', () => {
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.JWT_ACCESS_TTL = '5m';
    process.env.JWT_REFRESH_TTL = '2d';

    const config = configuration();

    expect(config.jwt.secret).toBe('a'.repeat(32));
    expect(config.jwt.accessTtl).toBe('5m');
    expect(config.jwt.refreshTtl).toBe('2d');
  });

  it('falls back to the documented default lifetimes', () => {
    process.env.JWT_SECRET = 'b'.repeat(32);
    delete process.env.JWT_ACCESS_TTL;
    delete process.env.JWT_REFRESH_TTL;

    const config = configuration();

    expect(config.jwt.accessTtl).toBe('15m');
    expect(config.jwt.refreshTtl).toBe('7d');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- configuration
```

Expected: FAIL — `Property 'jwt' does not exist on type 'AppConfig'`.

- [ ] **Step 3: Extend `AppConfig` and the factory**

In `src/config/configuration.ts`, add the `jwt` block to the interface and the returned object. Leave `app`, `database`, and `cors` untouched.

```ts
export interface AppConfig {
  app: {
    port: number;
    env: string;
  };
  database: {
    url: string;
  };
  cors: {
    origin: string;
  };
  jwt: {
    secret: string;
    accessTtl: string;
    refreshTtl: string;
  };
}
```

and inside the returned object, after `cors`:

```ts
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
  },
```

The `?? ''` on the secret mirrors how `database.url` is already written; Joi guarantees it is present at boot, so the fallback is unreachable in practice.

- [ ] **Step 4: Add the Joi rules**

In `src/config/env.validation.ts`, add to the schema object:

```ts
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('7d'),
```

`min(32)` makes a weak secret abort boot rather than silently producing forgeable tokens.

- [ ] **Step 5: Document the vars**

Append to `.env.example`:

```
# Authentication
# JWT_SECRET must be at least 32 characters; boot aborts otherwise.
JWT_SECRET=change-me-to-a-random-32-plus-character-secret
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
```

Add the same three lines to your local `.env` with a real random secret.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- configuration
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Verify nothing regressed**

```bash
npm run lint && npm run build && npm test && npm run test:e2e
```

Expected: all pass. E2E now requires `JWT_SECRET` in `.env` — if it is missing, the app aborts at boot with a Joi error naming the variable. That is the fail-fast behaviour working.

- [ ] **Step 8: Commit**

```bash
git add .env.example src/config/env.validation.ts src/config/configuration.ts src/config/configuration.spec.ts
git commit -m "feat: add JWT configuration with Joi validation"
```

---

## Task 2: User and RefreshToken models — the first committed migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_user_and_refresh_token/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma client types `User`, `RefreshToken`, `Role`, consumed by every later task.

- [ ] **Step 1: Add the models**

Append to `prisma/schema.prisma`, leaving `generator` and `datasource` untouched.

```prisma
enum Role {
  CUSTOMER
  ADMIN
}

model User {
  id            String         @id @default(uuid(7))
  email         String         @unique
  passwordHash  String         @map("password_hash")
  role          Role           @default(CUSTOMER)
  createdAt     DateTime       @default(now()) @map("created_at")
  updatedAt     DateTime       @updatedAt @map("updated_at")
  refreshTokens RefreshToken[]

  @@map("users")
}

model RefreshToken {
  id        String    @id @default(uuid(7))
  userId    String    @map("user_id")
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique @map("token_hash")
  familyId  String    @map("family_id")
  expiresAt DateTime  @map("expires_at")
  revokedAt DateTime? @map("revoked_at")
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  @@index([familyId])
  @@index([userId])
  @@map("refresh_tokens")
}
```

`familyId` is a plain indexed column, not a relation — a family is a lineage marker, not an entity. Per spec §3.5 it cannot be added retroactively, which is why it ships now.

- [ ] **Step 2: Generate the migration**

```bash
npx prisma migrate dev --name add_user_and_refresh_token
```

Expected: creates `prisma/migrations/<timestamp>_add_user_and_refresh_token/migration.sql`, applies it to the dev database, and regenerates the client.

- [ ] **Step 3: Read the generated SQL**

```bash
cat prisma/migrations/*/migration.sql
```

Confirm: `users` and `refresh_tokens` tables, a `Role` enum type, a unique index on `users.email`, a unique index on `refresh_tokens.token_hash`, and a foreign key with `ON DELETE CASCADE`. Note that `id` is a bare `TEXT NOT NULL` with **no default** — Prisma generates `uuid(7)` client-side. This is exactly why factories must not use raw SQL.

- [ ] **Step 4: Verify the e2e harness now takes the migrate-deploy branch**

```bash
npm run test:e2e
```

Expected: the output now reads `1 migration found in prisma/migrations` and `Applying migration ...` **instead of** `[e2e] No migrations found — skipping prisma migrate deploy.` All 13 existing tests still pass.

This is the first time a committed migration flows through `test/global-setup.ts`. If it fails here, stop — the harness is wrong, not the schema.

- [ ] **Step 5: Verify truncation across the new foreign key**

```bash
npm run test:e2e -- harness
```

Expected: PASS, 3 tests. `truncateAll()` now issues `TRUNCATE "public"."users", "public"."refresh_tokens" RESTART IDENTITY CASCADE` — the first time it has handled a real foreign key. If this fails, stop and report; do not work around it.

- [ ] **Step 6: Full verification**

```bash
npm run lint && npm run build && npm test
```

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add User and RefreshToken models with first migration"
```

---

## Task 3: Password hasher

Comes before factories because factories need a real Argon2id digest constant, which requires the library.

**Files:**
- Create: `src/modules/auth/password-hasher.service.ts`
- Test: `src/modules/auth/password-hasher.service.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `PasswordHasherService.hash(plain: string): Promise<string>` and `.verify(digest: string, plain: string): Promise<boolean>`.

- [ ] **Step 1: Install the library**

```bash
npm install @node-rs/argon2
```

- [ ] **Step 2: Verify it builds in the Docker image — do this now, not later**

```bash
docker build -t ecommerce-backend:argon2-check .
```

Expected: SUCCESS, resolving `@node-rs/argon2-linux-x64-musl` without invoking node-gyp.

**If this fails,** stop and report before writing more code. The fallback is to add build tooling to the **build stage only**, keeping the runtime image clean:

```dockerfile
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
RUN npm ci
```

Clean up: `docker rmi ecommerce-backend:argon2-check`.

- [ ] **Step 3: Write the failing test**

Create `src/modules/auth/password-hasher.service.spec.ts`. This exercises the real library rather than a mock — a hasher whose crypto is mocked tests nothing. Three real hashes cost roughly 150–300 ms, which is acceptable.

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService', () => {
  let hasher: PasswordHasherService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PasswordHasherService],
    }).compile();

    hasher = module.get<PasswordHasherService>(PasswordHasherService);
  });

  it('produces an argon2id digest that does not contain the password', async () => {
    const digest = await hasher.hash('correct horse battery staple');

    expect(digest).toContain('$argon2id$');
    expect(digest).not.toContain('correct horse battery staple');
  });

  it('verifies a correct password', async () => {
    const digest = await hasher.hash('s3cret-password');

    await expect(hasher.verify(digest, 's3cret-password')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const digest = await hasher.hash('s3cret-password');

    await expect(hasher.verify(digest, 'wrong-password')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed digest', async () => {
    await expect(hasher.verify('not-a-digest', 'anything')).resolves.toBe(
      false,
    );
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
npm test -- password-hasher
```

Expected: FAIL — `Cannot find module './password-hasher.service'`.

- [ ] **Step 5: Implement**

Create `src/modules/auth/password-hasher.service.ts`. Wrapping the library in one file means a future swap touches exactly one place.

```ts
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

@Injectable()
export class PasswordHasherService {
  async hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain);
    } catch {
      // A malformed or truncated digest must read as "does not match" rather
      // than crashing the login path.
      return false;
    }
  }
}
```

`@node-rs/argon2` defaults to Argon2id, which is what spec §7 of the foundation document requires.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- password-hasher
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Full verification and commit**

```bash
npm run lint && npm run build && npm test
git add package.json package-lock.json src/modules/auth/password-hasher.service.ts src/modules/auth/password-hasher.service.spec.ts
git commit -m "feat: add argon2id password hasher"
```

---

## Task 4: User factory

**Files:**
- Create: `test/factories/user.factory.ts`

**Interfaces:**
- Produces: `createUser(prisma, overrides?): Promise<User>`, plus `TEST_PASSWORD` and `TEST_PASSWORD_HASH` constants used by every later auth test.

- [ ] **Step 1: Generate a real digest for the constant**

Hashing per fixture would add ~50–100 ms to every test that needs a user. Generate one digest now and commit it as a constant.

```bash
node -e "require('@node-rs/argon2').hash('Test1234!').then(console.log)"
```

Copy the output — it starts with `$argon2id$v=19$`.

- [ ] **Step 2: Write the factory**

Create `test/factories/user.factory.ts`. It inserts through the Prisma client, never raw SQL, because `uuid(7)` is generated client-side and the column has no database default.

```ts
import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** The plaintext every factory-created user authenticates with. */
export const TEST_PASSWORD = 'Test1234!';

/**
 * A precomputed argon2id digest of TEST_PASSWORD. Hashing per fixture would
 * add ~50-100ms to every test that needs a user; argon2 is deliberately slow.
 * Regenerate with:
 *   node -e "require('@node-rs/argon2').hash('Test1234!').then(console.log)"
 */
export const TEST_PASSWORD_HASH = '<paste the digest from Step 1 here>';

let sequence = 0;

export async function createUser(
  prisma: PrismaService,
  overrides: Partial<Prisma.UserCreateInput> = {},
): Promise<User> {
  sequence += 1;

  return prisma.user.create({
    data: {
      email: `user${sequence}@example.test`,
      passwordHash: TEST_PASSWORD_HASH,
      role: Role.CUSTOMER,
      ...overrides,
    },
  });
}
```

The module-level `sequence` is safe because the e2e suite is serial (`maxWorkers: 1`). It would not be safe under parallel workers — do not reuse this pattern if isolation is ever added.

- [ ] **Step 3: Paste the real digest**

Replace `<paste the digest from Step 1 here>` with the Step 1 output. A placeholder left here makes every login test fail with a confusing "wrong password" rather than an obvious error.

- [ ] **Step 4: Verify lint and build**

```bash
npm run lint && npm run build
```

The factory is exercised by Task 5's tests; it has no test of its own, because a factory with no consumer is untested scaffolding either way.

- [ ] **Step 5: Commit**

```bash
git add test/factories/user.factory.ts
git commit -m "test: add user factory with precomputed password digest"
```

---

## Task 5: UsersModule (service-only)

**Files:**
- Create: `src/modules/users/users.service.ts`
- Create: `src/modules/users/users.module.ts`
- Test: `src/modules/users/users.service.spec.ts`

**Interfaces:**
- Consumes: Prisma `User` type (Task 2).
- Produces: `UsersService.findByEmail(email: string): Promise<User | null>`, `.findById(id: string): Promise<User | null>`, `.create(input: { email: string; passwordHash: string }): Promise<User>`. `UsersModule` exports `UsersService`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/users/users.service.spec.ts`, mocking `PrismaService` in the style of `health.controller.spec.ts`.

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: { user: { findUnique: jest.Mock; create: jest.Mock } };

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn(), create: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('looks a user up by email', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1' });

    const result = await service.findByEmail('a@example.test');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'a@example.test' },
    });
    expect(result).toEqual({ id: 'u1' });
  });

  it('normalises email to lowercase before lookup', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await service.findByEmail('MiXeD@Example.TEST');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'mixed@example.test' },
    });
  });

  it('looks a user up by id', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1' });

    const result = await service.findById('u1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
    });
    expect(result).toEqual({ id: 'u1' });
  });

  it('creates a user with a lowercased email', async () => {
    prisma.user.create.mockResolvedValueOnce({ id: 'u1' });

    await service.create({ email: 'NEW@Example.TEST', passwordHash: 'digest' });

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: 'new@example.test', passwordHash: 'digest' },
    });
  });
});
```

Email normalisation matters: without it `Alice@x.test` and `alice@x.test` are two accounts, and the unique index will not stop it.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- users.service
```

Expected: FAIL — `Cannot find module './users.service'`.

- [ ] **Step 3: Implement the service**

Create `src/modules/users/users.service.ts`.

```ts
import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
      },
    });
  }
}
```

`create` deliberately does not catch `P2002`. The global `HttpExceptionFilter` already maps it to 409 — catching it here would duplicate that mapping in a second place.

- [ ] **Step 4: Create the module**

Create `src/modules/users/users.module.ts`. No controller, per spec §2 scope discipline.

```ts
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test -- users.service
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Full verification and commit**

```bash
npm run lint && npm run build && npm test
git add src/modules/users
git commit -m "feat: add users module with service-only scope"
```

---

## Task 6: TokenService — JWT and refresh-token crypto

No database access, so it is fully unit-testable without mocking Prisma.

**Files:**
- Create: `src/modules/auth/token.service.ts`
- Create: `src/modules/auth/types/authenticated-user.ts`
- Test: `src/modules/auth/token.service.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `AuthenticatedUser` — `{ sub: string; email: string; role: Role }`
  - `TokenService.signAccessToken(user: User): Promise<string>`
  - `TokenService.verifyAccessToken(token: string): Promise<AuthenticatedUser>`
  - `TokenService.generateRefreshToken(): string` — 32 random bytes, base64url
  - `TokenService.hashToken(token: string): string` — SHA-256 hex
  - `TokenService.refreshTokenExpiryFrom(now: Date): Date`

- [ ] **Step 1: Install `@nestjs/jwt`**

```bash
npm install @nestjs/jwt
```

- [ ] **Step 2: Define the payload type**

Create `src/modules/auth/types/authenticated-user.ts`. The Express augmentation is what lets `request.user` typecheck under `strict`.

```ts
import { Role } from '@prisma/client';

export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: Role;
}

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
  }
}
```

- [ ] **Step 3: Write the failing test**

Create `src/modules/auth/token.service.spec.ts`.

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Role, User } from '@prisma/client';
import { TokenService } from './token.service';

const SECRET = 'x'.repeat(32);

const user: User = {
  id: 'user-1',
  email: 'a@example.test',
  passwordHash: 'digest',
  role: Role.CUSTOMER,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('TokenService', () => {
  let service: TokenService;

  beforeEach(async () => {
    const config = {
      get: (key: string): string =>
        key === 'jwt.accessTtl' ? '15m' : key === 'jwt.refreshTtl' ? '7d' : '',
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      providers: [TokenService, { provide: ConfigService, useValue: config }],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  it('signs an access token carrying id, email and role', async () => {
    const token = await service.signAccessToken(user);
    const payload = await service.verifyAccessToken(token);

    expect(payload.sub).toBe('user-1');
    expect(payload.email).toBe('a@example.test');
    expect(payload.role).toBe(Role.CUSTOMER);
  });

  it('rejects a malformed token', async () => {
    await expect(service.verifyAccessToken('not.a.token')).rejects.toBeDefined();
  });

  it('generates unique high-entropy refresh tokens', () => {
    const a = service.generateRefreshToken();
    const b = service.generateRefreshToken();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it('hashes tokens deterministically with sha256', () => {
    const token = 'a-refresh-token';

    expect(service.hashToken(token)).toBe(service.hashToken(token));
    expect(service.hashToken(token)).toHaveLength(64);
    expect(service.hashToken(token)).not.toContain(token);
  });

  it('computes refresh expiry from the configured lifetime', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const expiry = service.refreshTokenExpiryFrom(now);

    expect(expiry.toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
npm test -- token.service
```

Expected: FAIL — `Cannot find module './token.service'`.

- [ ] **Step 5: Implement**

Create `src/modules/auth/token.service.ts`.

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfig } from '../../config/configuration';
import { AuthenticatedUser } from './types/authenticated-user';

const REFRESH_TOKEN_BYTES = 32;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  async signAccessToken(user: User): Promise<string> {
    const payload: AuthenticatedUser = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    return this.jwtService.signAsync(payload, {
      expiresIn: this.configService.get('jwt.accessTtl', { infer: true }),
    });
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    return this.jwtService.verifyAsync<AuthenticatedUser>(token);
  }

  /**
   * 256 bits of CSPRNG output. High entropy is why these are hashed with
   * SHA-256 rather than argon2 — there is no dictionary to defend against,
   * and a salted digest could not be looked up by hash at all.
   */
  generateRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshTokenExpiryFrom(now: Date): Date {
    const ttl = this.configService.get('jwt.refreshTtl', { infer: true });

    return new Date(now.getTime() + parseDurationMs(ttl));
  }
}

/** Supports the `30s` / `15m` / `24h` / `7d` forms used in .env.example. */
function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);

  if (!match) {
    throw new Error(`Unsupported duration format: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test -- token.service
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Full verification and commit**

```bash
npm run lint && npm run build && npm test
git add package.json package-lock.json src/modules/auth/token.service.ts src/modules/auth/token.service.spec.ts src/modules/auth/types
git commit -m "feat: add token service for JWT and refresh token crypto"
```

---

## Task 7: RefreshTokenService — rotation and reuse detection

The security core of this phase. Spec §3 and §4.3 define the behaviour; this task encodes it.

**Files:**
- Create: `src/modules/auth/refresh-token.service.ts`
- Test: `src/modules/auth/refresh-token.service.spec.ts`

**Interfaces:**
- Consumes: `TokenService` (Task 6), `PrismaService`.
- Produces:
  - `RefreshTokenService.issue(userId: string, familyId?: string): Promise<string>` — returns the **plaintext** token; only its hash is stored.
  - `RefreshTokenService.rotate(presented: string): Promise<{ userId: string; token: string }>`
  - `RefreshTokenService.revokeFamily(familyId: string): Promise<void>`
  - `RefreshTokenService.revokeAllForUser(userId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/auth/refresh-token.service.spec.ts`. The reuse case is the one that matters most.

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;
  let prisma: {
    refreshToken: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let tokens: {
    generateRefreshToken: jest.Mock;
    hashToken: jest.Mock;
    refreshTokenExpiryFrom: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      refreshToken: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    tokens = {
      generateRefreshToken: jest.fn().mockReturnValue('plain-token'),
      hashToken: jest.fn((t: string) => `hash(${t})`),
      refreshTokenExpiryFrom: jest.fn().mockReturnValue(new Date('2099-01-01')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: PrismaService, useValue: prisma },
        { provide: TokenService, useValue: tokens },
      ],
    }).compile();

    service = module.get<RefreshTokenService>(RefreshTokenService);
  });

  it('stores only the hash, and returns the plaintext', async () => {
    const token = await service.issue('user-1');

    expect(token).toBe('plain-token');
    const createArg = prisma.refreshToken.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.tokenHash).toBe('hash(plain-token)');
    expect(JSON.stringify(createArg.data)).not.toContain('plain-token"');
  });

  it('rejects an unknown token', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce(null);

    await expect(service.rotate('nope')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revokes the whole family when a consumed token is replayed', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      revokedAt: new Date('2026-01-01'),
      expiresAt: new Date('2099-01-01'),
    });

    await expect(service.rotate('replayed')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
  });

  it('rejects an expired token without revoking the family', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      revokedAt: null,
      expiresAt: new Date('2000-01-01'),
    });

    await expect(service.rotate('stale')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('rotates a valid token, keeping the family and revoking the predecessor', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      revokedAt: null,
      expiresAt: new Date('2099-01-01'),
    });

    const result = await service.rotate('valid');

    expect(result).toEqual({ userId: 'user-1', token: 'plain-token' });
    expect(prisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: { revokedAt: expect.any(Date) as Date },
    });
    const createArg = prisma.refreshToken.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.familyId).toBe('fam-1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- refresh-token.service
```

Expected: FAIL — `Cannot find module './refresh-token.service'`.

- [ ] **Step 3: Implement**

Create `src/modules/auth/refresh-token.service.ts`.

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from './token.service';

/**
 * Every rejection uses this identical message. Distinguishing "unknown token"
 * from "expired" from "replayed" would tell an attacker which of those they
 * are holding.
 */
const REJECTION = 'Invalid refresh token';

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async issue(userId: string, familyId?: string): Promise<string> {
    const token = this.tokenService.generateRefreshToken();

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.tokenService.hashToken(token),
        familyId: familyId ?? randomUUID(),
        expiresAt: this.tokenService.refreshTokenExpiryFrom(new Date()),
      },
    });

    return token;
  }

  async rotate(presented: string): Promise<{ userId: string; token: string }> {
    const tokenHash = this.tokenService.hashToken(presented);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!existing) {
      throw new UnauthorizedException(REJECTION);
    }

    // Already consumed: either a legitimate race or a replayed steal. We
    // cannot tell them apart, so we assume compromise and burn the lineage.
    if (existing.revokedAt) {
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException(REJECTION);
    }

    if (existing.expiresAt <= new Date()) {
      throw new UnauthorizedException(REJECTION);
    }

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    const token = await this.issue(existing.userId, existing.familyId);

    return { userId: existing.userId, token };
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- refresh-token.service
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Full verification and commit**

```bash
npm run lint && npm run build && npm test
git add src/modules/auth/refresh-token.service.ts src/modules/auth/refresh-token.service.spec.ts
git commit -m "feat: add refresh token rotation with reuse detection"
```

---

## Task 8: AuthService

**Files:**
- Create: `src/modules/auth/auth.service.ts`
- Test: `src/modules/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `UsersService` (Task 5), `PasswordHasherService` (Task 3), `TokenService` (Task 6), `RefreshTokenService` (Task 7).
- Produces: `AuthService.register(email, password)`, `.login(email, password)`, `.refresh(token)`, `.logout(userId)`. The first three resolve to `{ accessToken: string; refreshToken: string; user: User }`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/auth/auth.service.spec.ts`.

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { PasswordHasherService } from './password-hasher.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';

const user: User = {
  id: 'user-1',
  email: 'a@example.test',
  passwordHash: 'digest',
  role: Role.CUSTOMER,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AuthService', () => {
  let service: AuthService;
  let users: { findByEmail: jest.Mock; findById: jest.Mock; create: jest.Mock };
  let hasher: { hash: jest.Mock; verify: jest.Mock };
  let tokens: { signAccessToken: jest.Mock };
  let refreshTokens: {
    issue: jest.Mock;
    rotate: jest.Mock;
    revokeAllForUser: jest.Mock;
  };

  beforeEach(async () => {
    users = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn().mockResolvedValue(user),
    };
    hasher = {
      hash: jest.fn().mockResolvedValue('digest'),
      verify: jest.fn().mockResolvedValue(true),
    };
    tokens = { signAccessToken: jest.fn().mockResolvedValue('access-token') };
    refreshTokens = {
      issue: jest.fn().mockResolvedValue('refresh-token'),
      rotate: jest.fn(),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: PasswordHasherService, useValue: hasher },
        { provide: TokenService, useValue: tokens },
        { provide: RefreshTokenService, useValue: refreshTokens },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('hashes the password on register and never stores plaintext', async () => {
    const result = await service.register('a@example.test', 'Test1234!');

    expect(hasher.hash).toHaveBeenCalledWith('Test1234!');
    expect(users.create).toHaveBeenCalledWith({
      email: 'a@example.test',
      passwordHash: 'digest',
    });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
  });

  it('logs in with correct credentials', async () => {
    users.findByEmail.mockResolvedValueOnce(user);

    const result = await service.login('a@example.test', 'Test1234!');

    expect(result.user).toBe(user);
  });

  it('rejects an unknown email and a wrong password identically', async () => {
    users.findByEmail.mockResolvedValueOnce(null);
    const unknown = await service
      .login('nobody@example.test', 'Test1234!')
      .catch((error: UnauthorizedException) => error);

    users.findByEmail.mockResolvedValueOnce(user);
    hasher.verify.mockResolvedValueOnce(false);
    const wrongPassword = await service
      .login('a@example.test', 'wrong')
      .catch((error: UnauthorizedException) => error);

    expect(unknown).toBeInstanceOf(UnauthorizedException);
    expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
    expect((unknown as UnauthorizedException).message).toBe(
      (wrongPassword as UnauthorizedException).message,
    );
  });

  it('still verifies a password when the user does not exist', async () => {
    users.findByEmail.mockResolvedValueOnce(null);

    await service.login('nobody@example.test', 'Test1234!').catch(() => null);

    // Without this, "user not found" returns measurably faster than
    // "wrong password", turning login into an email-enumeration oracle.
    expect(hasher.verify).toHaveBeenCalled();
  });

  it('issues a new pair on refresh', async () => {
    refreshTokens.rotate.mockResolvedValueOnce({
      userId: 'user-1',
      token: 'next-refresh',
    });
    users.findById.mockResolvedValueOnce(user);

    const result = await service.refresh('presented');

    expect(result.refreshToken).toBe('next-refresh');
    expect(result.accessToken).toBe('access-token');
  });

  it('revokes every token for the user on logout', async () => {
    await service.logout('user-1');

    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('user-1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- auth.service
```

Expected: FAIL — `Cannot find module './auth.service'`.

- [ ] **Step 3: Implement**

Create `src/modules/auth/auth.service.ts`.

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { PasswordHasherService } from './password-hasher.service';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: User;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

/**
 * A valid argon2id digest of a value nobody knows. Verified against when the
 * email is unknown so that a missing user costs the same time as a wrong
 * password.
 */
const DUMMY_DIGEST = '$argon2id$REPLACE_ME_IN_STEP_4';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordHasher: PasswordHasherService,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const passwordHash = await this.passwordHasher.hash(password);
    // A duplicate email raises P2002, which HttpExceptionFilter maps to 409.
    const user = await this.usersService.create({ email, passwordHash });

    return this.issueFor(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.usersService.findByEmail(email);
    const matches = await this.passwordHasher.verify(
      user?.passwordHash ?? DUMMY_DIGEST,
      password,
    );

    if (!user || !matches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.issueFor(user);
  }

  async refresh(presented: string): Promise<AuthResult> {
    const { userId, token } = await this.refreshTokenService.rotate(presented);
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return {
      accessToken: await this.tokenService.signAccessToken(user),
      refreshToken: token,
      user,
    };
  }

  async logout(userId: string): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(userId);
  }

  private async issueFor(user: User): Promise<AuthResult> {
    return {
      accessToken: await this.tokenService.signAccessToken(user),
      refreshToken: await this.refreshTokenService.issue(user.id),
      user,
    };
  }
}
```

- [ ] **Step 4: Replace the dummy digest with a real one**

`$argon2id$REPLACE_ME_IN_STEP_4` is not a valid digest. Left in place, `verify` throws, the hasher catches it and returns `false` early — so login still *behaves* correctly and **every test still passes**, while the timing defence silently does nothing. This is the one step in the plan whose omission is invisible. Do not skip it.

Generate a digest of a random value nobody knows, and paste it in:

```bash
node -e "require('@node-rs/argon2').hash(require('node:crypto').randomBytes(32).toString('hex')).then(console.log)"
```

Confirm the constant now starts with `$argon2id$v=19$` and contains no `REPLACE_ME`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test -- auth.service
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Full verification and commit**

```bash
npm run lint && npm run build && npm test
git add src/modules/auth/auth.service.ts src/modules/auth/auth.service.spec.ts
git commit -m "feat: add auth service with register, login, refresh and logout"
```

---

## Task 9: DTOs, controller, and module wiring

**Files:**
- Create: `src/modules/auth/dto/register.dto.ts`, `login.dto.ts`, `refresh.dto.ts`, `user-response.dto.ts`, `auth-response.dto.ts`
- Create: `src/modules/auth/auth.controller.ts`
- Create: `src/modules/auth/auth.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `AuthService` (Task 8).
- Produces: `AuthModule` (exports `JwtAuthGuard` after Task 10), the five routes, and `UserResponseDto.from(user)`.

- [ ] **Step 1: Write the request DTOs**

Create `src/modules/auth/dto/register.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Test1234!', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
```

Create `src/modules/auth/dto/login.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Test1234!' })
  @IsString()
  password!: string;
}
```

`LoginDto` deliberately omits `@MinLength` — length rules belong on registration. Enforcing them at login would reject a short legacy password with 400 instead of 401 and leak the policy.

Create `src/modules/auth/dto/refresh.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RefreshDto {
  @ApiProperty({ description: 'The refresh token issued by login or refresh' })
  @IsString()
  refreshToken!: string;
}
```

- [ ] **Step 2: Write the response DTOs**

Create `src/modules/auth/dto/user-response.dto.ts`. Explicit mapping is the only thing that stops `passwordHash` leaking — `@Exclude()` silently no-ops on Prisma's plain objects.

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';

export class UserResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: 'customer@example.com' })
  email!: string;

  @ApiProperty({ enum: Role, example: Role.CUSTOMER })
  role!: Role;

  @ApiProperty()
  createdAt!: Date;

  static from(user: User): UserResponseDto {
    const dto = new UserResponseDto();

    dto.id = user.id;
    dto.email = user.email;
    dto.role = user.role;
    dto.createdAt = user.createdAt;

    return dto;
  }
}
```

Create `src/modules/auth/dto/auth-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { UserResponseDto } from './user-response.dto';

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;

  static from(result: {
    accessToken: string;
    refreshToken: string;
    user: User;
  }): AuthResponseDto {
    const dto = new AuthResponseDto();

    dto.accessToken = result.accessToken;
    dto.refreshToken = result.refreshToken;
    dto.user = UserResponseDto.from(result.user);

    return dto;
  }
}
```

- [ ] **Step 3: Write the controller**

Create `src/modules/auth/auth.controller.ts`. `@Public()` and `@CurrentUser` land in Task 10; for now every route is reachable because no guard exists yet.

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from '../users/users.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new account' })
  @ApiResponse({ status: 201, description: 'Account created' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return AuthResponseDto.from(
      await this.authService.register(dto.email, dto.password),
    );
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for tokens' })
  @ApiResponse({ status: 200, description: 'Authenticated' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return AuthResponseDto.from(
      await this.authService.login(dto.email, dto.password),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token' })
  @ApiResponse({ status: 200, description: 'New token pair issued' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(@Body() dto: RefreshDto): Promise<AuthResponseDto> {
    return AuthResponseDto.from(
      await this.authService.refresh(dto.refreshToken),
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke every refresh token for the caller' })
  @ApiResponse({ status: 204, description: 'Logged out' })
  async logout(@Req() request: Request): Promise<void> {
    await this.authService.logout(request.user!.sub);
  }

  @Get('me')
  @ApiOperation({ summary: 'Return the authenticated principal' })
  @ApiResponse({ status: 200, description: 'The current user' })
  async me(@Req() request: Request): Promise<UserResponseDto> {
    const user = await this.usersService.findById(request.user!.sub);

    return UserResponseDto.from(user!);
  }
}
```

The two `!` assertions are safe only once the global guard is in place — Task 10 adds it, and the 401 regression test proves it. Add this comment above `logout` so the coupling is visible:

```ts
  // request.user is guaranteed by the global JwtAuthGuard; these routes are
  // not marked @Public(), so an unauthenticated request never reaches here.
```

- [ ] **Step 4: Wire the module**

Create `src/modules/auth/auth.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../../config/configuration';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordHasherService } from './password-hasher.service';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => ({
        secret: configService.get('jwt.secret', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordHasherService,
    TokenService,
    RefreshTokenService,
  ],
  exports: [TokenService],
})
export class AuthModule {}
```

In `src/app.module.ts`, add `AuthModule` to `imports` after `HealthModule`.

- [ ] **Step 5: Verify the routes exist**

```bash
npm run build && npm run start
```

In another terminal:

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@example.test","password":"Test1234!"}'
```

Expected: 201 with `accessToken`, `refreshToken`, and a `user` object **containing no `passwordHash`**. Repeat the same call: expected 409 with the standard error shape — this is the first time P2002 has ever been triggered by a real request. Stop the server.

- [ ] **Step 6: Full verification and commit**

```bash
npm run lint && npm run build && npm test && npm run test:e2e
git add src/modules/auth src/app.module.ts
git commit -m "feat: add auth endpoints with explicit response DTOs"
```

---

## Task 10: Global fail-closed JwtAuthGuard

**This task breaks `/health` and the ping fixture until they are marked `@Public()`.** That is the guard proving it fails closed. Both fixes are in this task.

**Files:**
- Create: `src/modules/auth/decorators/public.decorator.ts`
- Create: `src/modules/auth/guards/jwt-auth.guard.ts`
- Modify: `src/modules/auth/auth.module.ts`, `src/modules/auth/auth.controller.ts`
- Modify: `src/modules/health/health.controller.ts`
- Modify: `test/fixtures/ping.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/auth-guard.e2e-spec.ts`

**Interfaces:**
- Produces: `@Public()`, `JwtAuthGuard`, and `request.user: AuthenticatedUser` on every guarded route.

- [ ] **Step 1: Write the failing regression test**

Create `test/auth-guard.e2e-spec.ts`. Foundation spec §2 requires this test specifically to catch a future refactor dropping the `APP_GUARD` provider.

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';

describe('global auth guard (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a protected route with no token', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('rejects a malformed authorization header', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('returns the standard error shape on 401', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401);

    expect(response.body).toMatchObject({
      statusCode: 401,
      error: expect.any(String) as string,
      timestamp: expect.any(String) as string,
      path: '/api/v1/auth/me',
    });
  });

  it('leaves /health public', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('leaves login public', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'Test1234!' })
      .expect(401); // reached the handler — not blocked by the guard
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:e2e -- auth-guard
```

Expected: FAIL — `/api/v1/auth/me` returns 500 (no `request.user`) rather than 401, because no guard exists yet.

- [ ] **Step 3: Create the `@Public()` decorator**

Create `src/modules/auth/decorators/public.decorator.ts`:

```ts
import { CustomDecorator, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);
```

- [ ] **Step 4: Implement the guard**

Create `src/modules/auth/guards/jwt-auth.guard.ts`:

```ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TokenService } from '../token.service';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException();
    }

    try {
      request.user = await this.tokenService.verifyAccessToken(
        header.slice(BEARER_PREFIX.length),
      );
    } catch {
      // Expired, tampered, or wrong-secret tokens are all just "unauthorized".
      throw new UnauthorizedException();
    }

    return true;
  }
}
```

- [ ] **Step 5: Register the guard globally**

In `src/modules/auth/auth.module.ts`, add `JwtAuthGuard` to `providers` and to `exports`.

In `src/app.module.ts`, add to `providers`:

```ts
  providers: [
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
  ],
```

with `import { APP_GUARD } from '@nestjs/core';` and `import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';`. `useExisting` reuses the instance `AuthModule` already provides, so its dependencies resolve there.

- [ ] **Step 6: Mark the public routes**

In `src/modules/auth/auth.controller.ts`, add `@Public()` to `register`, `login`, and `refresh`.

**`refresh` must be `@Public()`.** By definition the caller's access token has expired — that is why they are refreshing. The refresh token is validated inside the service. Marking it protected locks every user out permanently.

In `src/modules/health/health.controller.ts`, add `@Public()` to the controller class, below `@ApiTags('health')`.

In `test/fixtures/ping.module.ts`, add `@Public()` to `PingController`. Without this, all nine `routing.e2e-spec.ts` tests fail with 401 — the fixture proves routing, not auth.

Add `@ApiBearerAuth()` to the `logout` and `me` handlers so Swagger attaches the token.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run test:e2e -- auth-guard
npm run test:e2e
```

Expected: `auth-guard` PASS, 5 tests. Full suite PASS — confirm `routing.e2e-spec.ts` and `app.e2e-spec.ts` still pass, which proves the `@Public()` marks landed.

- [ ] **Step 8: Full verification and commit**

```bash
npm run lint && npm run build && npm test
git add src/modules/auth src/modules/health/health.controller.ts src/app.module.ts test/fixtures/ping.module.ts test/auth-guard.e2e-spec.ts
git commit -m "feat: add global fail-closed JwtAuthGuard with @Public opt-out"
```

---

## Task 11: Rate limiting

**Files:**
- Modify: `src/app.module.ts`, `src/modules/auth/auth.controller.ts`, `package.json`
- Test: `test/auth-throttle.e2e-spec.ts` (create)

**Interfaces:**
- Produces: a 100 req/60 s global limit and a 5 req/60 s limit on `register`, `login`, and `refresh`.

- [ ] **Step 1: Install**

```bash
npm install @nestjs/throttler
```

- [ ] **Step 2: Write the failing test**

Create `test/auth-throttle.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';

describe('auth rate limiting (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('throttles repeated login attempts and keeps the standard error shape', async () => {
    const attempt = (): request.Test =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.test', password: 'Test1234!' });

    for (let i = 0; i < 5; i += 1) {
      await attempt().expect(401);
    }

    const blocked = await attempt().expect(429);

    expect(blocked.body).toMatchObject({
      statusCode: 429,
      timestamp: expect.any(String) as string,
      path: '/api/v1/auth/login',
    });
  });
});
```

The 429 assertion also proves `ThrottlerException` flows through `HttpExceptionFilter` correctly — the filter has never shaped a throttler error before.

- [ ] **Step 3: Run it to verify it fails**

```bash
npm run test:e2e -- auth-throttle
```

Expected: FAIL — the sixth request returns 401, not 429.

- [ ] **Step 4: Configure the module**

In `src/app.module.ts`, add to `imports`:

```ts
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
      { name: 'auth', ttl: 60_000, limit: 5 },
    ]),
```

and register the guard **before** `JwtAuthGuard` in `providers`:

```ts
  providers: [
    // Order matters: global guards run in registration order, so an
    // unauthenticated flood is rejected before any token or database work.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
  ],
```

with `import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';`.

- [ ] **Step 5: Apply the stricter auth limit**

In `src/modules/auth/auth.controller.ts`, add to `register`, `login`, and `refresh`:

```ts
  @Throttle({ auth: { ttl: 60_000, limit: 5 } })
```

with `import { Throttle } from '@nestjs/throttler';`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:e2e -- auth-throttle
```

Expected: PASS, 1 test.

- [ ] **Step 7: Full verification and commit**

```bash
npm run lint && npm run build && npm test && npm run test:e2e
git add package.json package-lock.json src/app.module.ts src/modules/auth/auth.controller.ts test/auth-throttle.e2e-spec.ts
git commit -m "feat: add global and auth-specific rate limiting"
```

Note: because the suite is serial and the throttler is in-memory per process, this spec's 5 consumed attempts do not leak into other spec files — each `createTestApp()` builds a fresh module with a fresh store.

---

## Task 12: Full auth flow e2e

**Files:**
- Create: `test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `createTestApp()` (`test/helpers/create-test-app.ts`), `truncateAll()` (`test/helpers/truncate.ts`), and every route from Tasks 9–11.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the tests**

Create `test/auth.e2e-spec.ts`. This is the phase's real acceptance criteria — especially family revocation.

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { PrismaService } from '../src/prisma/prisma.service';

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: string };
}

describe('authentication (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const register = (email: string): request.Test =>
    request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Test1234!' });

  it('registers, then returns the principal from /auth/me', async () => {
    const created = await register('a@example.test').expect(201);
    const body = created.body as AuthBody;

    expect(body.user.email).toBe('a@example.test');
    expect(JSON.stringify(body)).not.toContain('passwordHash');

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);

    expect((me.body as { email: string }).email).toBe('a@example.test');
  });

  it('rejects a duplicate email with 409', async () => {
    await register('dupe@example.test').expect(201);

    await register('dupe@example.test').expect(409);
  });

  it('returns an identical 401 for unknown email and wrong password', async () => {
    await register('real@example.test').expect(201);

    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.test', password: 'Test1234!' })
      .expect(401);

    const wrong = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'real@example.test', password: 'WrongPass1!' })
      .expect(401);

    expect((unknown.body as { message: string }).message).toBe(
      (wrong.body as { message: string }).message,
    );
  });

  it('rotates the refresh token and invalidates the presented one', async () => {
    const created = await register('rot@example.test').expect(201);
    const first = (created.body as AuthBody).refreshToken;

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);

    const second = (refreshed.body as AuthBody).refreshToken;
    expect(second).not.toBe(first);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(401);
  });

  it('revokes the entire family when a consumed token is replayed', async () => {
    const created = await register('fam@example.test').expect(201);
    const first = (created.body as AuthBody).refreshToken;

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);
    const second = (refreshed.body as AuthBody).refreshToken;

    // Replaying the consumed token burns the lineage...
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(401);

    // ...so the currently-valid successor stops working too.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second })
      .expect(401);
  });

  it('invalidates refresh tokens after logout', async () => {
    const created = await register('out@example.test').expect(201);
    const body = created.body as AuthBody;

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(401);
  });
});
```

- [ ] **Step 2: Run them**

```bash
npm run test:e2e -- auth.e2e
```

Expected: PASS, 6 tests. The family-revocation test is the one that matters — if it passes, spec §3's core security property holds.

- [ ] **Step 3: Full verification**

```bash
npm run lint && npm run build && npm test && npm run test:e2e
docker build -t ecommerce-backend:phase1 . && docker rmi ecommerce-backend:phase1
```

- [ ] **Step 4: Commit**

```bash
git add test/auth.e2e-spec.ts
git commit -m "test: add end-to-end coverage for the auth flow"
```

---

## Task 13: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by code.

- [ ] **Step 1: Update `CLAUDE.md`**

Under `## Security Requirements`, append:

```
- Passwords are hashed with Argon2id (`@node-rs/argon2`); refresh tokens are hashed with SHA-256. Never swap these — Argon2 defends low-entropy secrets, and a salted digest cannot be looked up by hash, which reuse detection requires.
- `JwtAuthGuard` is global and fails closed. A route without `@Public()` is protected. `POST /auth/refresh` must stay `@Public()` — the caller's access token is expired by definition.
- Rate limiting: 100 req/min globally, 5 req/min on `register`, `login`, and `refresh`. `ThrottlerGuard` is registered before `JwtAuthGuard` so floods are rejected before auth work.
```

Under `## Important Constraints`, append:

```
- `RolesGuard` and `@Roles()` are Phase 2, not Phase 1. The `Role` column exists from Phase 1; the guard arrives with the first admin-only route so it ships with a real 403 test.
```

- [ ] **Step 2: Update `README.md`**

Change the Project Status line to `Current phase: **products (Phase 2)**` and mark authentication complete:

```
- ✅ Authentication: register, login, refresh with rotation, logout, global JWT guard
```

Add the three new env vars to any setup notes that enumerate them.

- [ ] **Step 3: Final verification**

```bash
npm run lint && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: record Phase 1 authentication conventions"
```

---

## Definition of Done

| Spec requirement | Task |
|---|---|
| §4.1 `User`, `RefreshToken`, `Role` with `familyId` | 2 |
| §4.2 SHA-256 for tokens, Argon2id for passwords | 3, 6 |
| §4.3 Rotation, reuse detection, family revocation | 7, 12 |
| §5 `@node-rs/argon2` verified in the Docker build | 3 |
| §6 15m/7d lifetimes, secret from env with Joi floor | 1 |
| §7 `Role` column ships; `RolesGuard` deferred | 2 |
| §8 Five routes, `@Public()` on refresh, identical 401s | 9, 10, 12 |
| §8 Global fail-closed guard + 401 regression test | 10 |
| §9 100/60s global, 5/60s auth | 11 |
| §10 `test/factories/` via Prisma client | 4 |
| §10 Required e2e list | 10, 11, 12 |

**Deliberately not built:** `RolesGuard`/`@Roles()` (Phase 2), refresh-token cleanup job (Phase 5 BullMQ), Redis-backed throttler storage (Phase 5), CORS tightening (Phase 6). The pagination primitives gain no consumer in this phase and remain unproven until Phase 2.
