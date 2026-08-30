# Phase 1 — Authentication Design Spec

**Status:** reviewed — §13 open items closed and §5 verified on 2026-08-13; ready for implementation
**Depends on:** `2026-08-12-foundation-architecture-design.md` (the foundation spec), Phase F as merged
**Owns:** `User`, `RefreshToken`, the first committed migration, `UsersModule` (service-only), `AuthModule`, the global `JwtAuthGuard`, `src/common/decorators/public.decorator.ts`, `@nestjs/throttler`, `test/factories/`

---

## 1. Purpose

The foundation spec fixed the cross-phase conventions and committed to an auth *model* (§7) without designing the endpoints. This document does that design, and resolves the one question in Phase 1 that has no consensus answer: what happens when two refresh requests race.

Everything here is grounded in what this repository actually does — the foundation spec, `CLAUDE.md`, and facts observed in the codebase — rather than in generic best practice. Where the two diverge, the repo wins and the divergence is stated.

**Out of scope:** product/catalogue design (Phase 2), cart and orders (Phase 3), payments (Phase 4), Redis-backed anything (Phase 5), CORS tightening and structured logging (Phase 6).

---

## 2. Decisions at a glance

| Question | Decision | Deviates from foundation spec? |
|---|---|---|
| Refresh concurrency | Strict reuse detection, revoke whole family | No — confirms §7 |
| Refresh token hashing | **SHA-256**, not Argon2 | Yes — §7 says "hashed", unspecified algorithm |
| Password hashing | Argon2id via **`@node-rs/argon2`** | No — §7 says Argon2id; this picks the implementation |
| Access token lifetime | 15 minutes | No |
| Refresh token lifetime | 7 days | No |
| Token transport | JSON response body + `Authorization: Bearer` | No — §1 |
| Role model | `Role` enum column | No |
| `RolesGuard` | **Deferred to Phase 2** | **Yes** — §9 lists "roles" under Phase 1 |
| `@Public()` / guard placement | `@Public()` in `common/`, guard in `auth/` | **Yes** — §2 puts both in `common/` |
| Throttling | Global 100/60s; auth routes 5/60s | No |

Three deliberate deviations, each argued in place: §4.2 (SHA-256 for refresh tokens), §7 (`RolesGuard` deferred to Phase 2), and §8 (`@Public()` in `common/`, `JwtAuthGuard` in `auth/`). §5 picks an Argon2id *implementation* and is a refinement of §7 of the foundation spec, not a departure from it.

---

## 3. The question that needed thought: refresh token concurrency

Two clients refresh at the same moment. One wins and rotates the token. The loser now presents a token that was consumed microseconds ago — which, on the wire, is **indistinguishable from an attacker replaying a stolen token**. The server cannot tell the difference from the request alone. Every approach below is a different answer to "what should we assume when we cannot know?"

### 3.1 The repo-specific fact that decides it

Foundation spec §1, *Client assumption*:

> The API is consumed via **Swagger UI and HTTP clients only**. There is no browser SPA.
> - Tokens are returned in JSON response bodies and sent as `Authorization: Bearer <token>`.
> - No cookie-based auth, no CSRF protection, no `credentials: true` CORS handling.

This matters more than any general argument. **Concurrent refresh with the same token is fundamentally a browser-SPA failure mode**: multiple tabs, each running an interceptor that fires a refresh on the first 401, all sharing one token in `localStorage`. With Swagger UI and `curl`, refresh is a deliberate act by one caller at a time. Reproducing the race requires a purpose-built concurrent script.

Confirmed with the user during design: the API-only assumption holds for the foreseeable future. If a browser frontend is ever added, §3.5 describes what changes.

### 3.2 Approach (a) — strict reuse detection, revoke the family

On presentation of an already-revoked token, treat it as compromise: revoke every token in that lineage, forcing a full re-login.

**Security:** strongest available. It is the OAuth 2.0 Security BCP recommendation for public clients, and it is the only option that reliably converts a stolen-token replay into a detectable, contained event.

**Cost, honestly:** a legitimate concurrent refresh logs the user out everywhere. **How often does that actually bite?** For a browser SPA with multiple tabs: often enough to be a well-known support burden — it is the single most common complaint about strict rotation. For this API: rarely to never, because there is no client that auto-refreshes in parallel. The cost is real in general and close to zero here.

**Model requirements:** `familyId` on every token to define lineage, `revokedAt` to distinguish consumed from active, `tokenHash` unique for lookup.

### 3.3 Approach (b) — grace window

For a short interval after rotation, the previous token still resolves to its successor and returns the same new pair rather than erroring.

**Security cost, precisely:** the window is exactly the period in which a stolen token can be replayed **invisibly**. Reuse inside it is indistinguishable from the legitimate race by construction — that is the entire mechanism. A 10-second window is a 10-second hole in the one detection mechanism the design has. Detection ability isn't reduced, it's *suspended* for the window's duration.

**Window length:** typical implementations use 5–30 seconds — long enough to cover a tab race plus network jitter, short enough to bound exposure. There is no principled value; it is a guess about client timing.

**Model requirements:** everything in (a) **plus** `replacedById String?` (so a consumed token can resolve to its successor) and reliance on `updatedAt`/`revokedAt` to compute window expiry.

**Verdict: rejected.** It pays a permanent, unbounded-in-principle security cost to fix a problem this client shape does not have.

### 3.4 Approach (c) — per-user serialization

Take a lock so refreshes for one user cannot interleave — `SELECT … FOR UPDATE` on the token row, or `pg_advisory_xact_lock` keyed on user id.

> **Corrected after the Phase 1 final review.** The original text of this
> section argued that serialization was purely orthogonal — that "locking alone
> changes nothing observable" — and rejected it on that basis. **That reasoning
> was wrong**, and it is corrected below rather than deleted, because the
> original error is the kind a future phase would otherwise repeat.

**The claim that was wrong.** The earlier argument ran: after a lock, the loser
still presents a consumed token, so the server still needs (a)'s or (b)'s
semantics to answer it, and therefore locking changes nothing observable.

The second half does not follow. **Without atomicity the loser never presents a
consumed token at all** — it presents one it already read as *unconsumed*. Under
a plain `findUnique` → check `revokedAt` → `update` sequence, both requests read
`revokedAt: null`, both pass the check, and both rotate. The result is two live
siblings in one family and **the reuse detection never fires**: the token was
consumed twice without ever being observed as consumed. So the difference is
observable, and it is precisely the difference between approach (a) working and
approach (a) being silently bypassed.

This was confirmed empirically against Postgres during the final review: under
the old pattern, two concurrent consumes of the same row both reported success.

**What the original text missed: the option between "nothing" and "a lock".**
It weighed only `SELECT … FOR UPDATE` and `pg_advisory_xact_lock`, and rejected
both on complexity — a transaction boundary around the refresh path, and a lock
that must not leak across the JWT signing call. Those objections are fair, and
they still stand. But there is a cheaper point in the space: make the *consume*
step a compare-and-swap, carrying the predicate in the write itself.

```
UPDATE refresh_tokens SET revoked_at = now()
 WHERE id = $1 AND revoked_at IS NULL      -- 1 row, or 0 if someone else won
```

`count === 1` means this request consumed the token. `count === 0` means a
concurrent request consumed it first — which on the wire is indistinguishable
from a replayed steal, so it takes the same answer the `revokedAt` branch gives:
revoke the family, return the uniform 401. Postgres serialises the two
statements on the row, so exactly one can match.

**Cost:** one statement. No transaction, no explicit lock, nothing held across
JWT signing, no Redis, no new dependency. The complexity objection that defeats
(c) does not apply to it.

**Verdict: adopted for Phase 1.** Row-level and advisory locking remain
**rejected** — genuine complexity for a race this client shape cannot generate.
But atomicity at the write boundary is not the same thing as locking, and it is
what makes approach (a)'s guarantee true as stated rather than true only when
requests happen not to overlap.

### 3.5 Recommendation, and what is being traded away

**Adopt (a): strict reuse detection with family revocation.** This confirms foundation spec §7 rather than overturning it.

**What we trade away:** if a browser frontend is ever added, the two-tab logout problem becomes real and users will hit it. The mitigation at that point is (b) layered on top — which is a *nullable column plus service logic*, not a redesign. That is an acceptable future cost.

**Correcting a premise from the task brief.** The brief warned that the `RefreshToken` shape "lands in our first real migration and is expensive to change later." That is mostly not true, and the distinction matters for how much to over-build now:

- Adding `replacedById String?` later is a **nullable column with no default** — in Postgres a catalogue-only change, no table rewrite, effectively instant at any size this project will reach.
- What *is* irreversible is **lineage**. Without `familyId` from the first migration, families cannot be reconstructed for tokens already issued; a backfill has no source of truth.

So the rule is: **ship `familyId` now** (approach (a) requires it anyway), and **do not** speculatively add grace-window fields. The door to (b) stays open at near-zero cost.

---

## 4. Data model

### 4.1 Schema

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

Follows the data conventions in `CLAUDE.md`: `uuid(7)` primary keys, `createdAt`/`updatedAt` on every model, PascalCase singular models with `@@map` to snake_case plural tables, native Prisma enums.

`onDelete: Cascade` means deleting a user removes their tokens — and makes `users` → `refresh_tokens` the **first foreign key in this codebase**, which has consequences for the test harness (§9).

### 4.2 Refresh tokens are hashed with SHA-256, not Argon2

**This is a deliberate deviation** — foundation spec §7 says refresh tokens are "persisted hashed" without naming an algorithm, and the obvious reading is "reuse the password hasher."

Argon2 exists to make **low-entropy** secrets expensive to brute-force: a human-chosen password has maybe 30 bits of entropy, so each guess must be made costly. A refresh token is 256 bits of CSPRNG output. There is no dictionary, no guessing strategy, and no offline attack that a slow hash defends against.

Using Argon2 here would add ~50–100 ms to every refresh — a hot path — for no security gain, and would make the reuse-detection lookup a linear scan (you cannot index on a salted Argon2 digest, so you cannot look a token up by hash at all without storing an additional lookup key). SHA-256 is deterministic, indexable, and appropriate for high-entropy secrets. (bcrypt would additionally silently truncate at 72 bytes.)

**Rule: Argon2id for passwords, SHA-256 for tokens.** Both are recorded in `CLAUDE.md` so a later phase does not "fix" this.

### 4.3 Refresh algorithm

1. Hash the presented token (SHA-256) and look it up by `tokenHash`.
2. **Not found** → 401. Reveals nothing.
3. **Found, `revokedAt` set** → reuse detected. Revoke every token sharing this `familyId`, then 401.
4. **Found, `expiresAt` in the past** → 401.
5. Otherwise: set `revokedAt` on this token, insert a successor carrying the **same `familyId`**, return a new access + refresh pair.

Logout revokes the entire family — that is what makes logout meaningful rather than cosmetic, and it is the property foundation spec §7 called out as the point of persisting tokens at all.

---

## 5. Password hashing: `@node-rs/argon2`

Argon2id is fixed by foundation spec §7. This spec chooses the **implementation**, and the choice is driven by a fact that only became relevant after Phase F: **the Dockerfile is now built in CI on every push and PR.**

The build stage is bare:

```dockerfile
FROM node:20-alpine AS build
RUN npm ci        # no python3, no make, no g++
```

The widely-used `argon2` package falls back to a node-gyp compile whenever no matching musl prebuild resolves — which would fail `npm ci` inside the image, in the one CI job that has never built a non-pure-JS dependency.

`@node-rs/argon2` ships Rust/napi prebuilds including musl targets, defaults to Argon2id, and requires no toolchain. It keeps a freshly-verified Dockerfile untouched.

**This must be verified, not assumed** — "ships prebuilds" is a README claim, and this repository has twice found that correct-by-inspection is not the same as proven.

### ✅ Verified 2026-08-13 — no `Dockerfile` change needed

A throwaway `node:20-alpine` build was run against this repository's real `package-lock.json`, with no `python3`/`make`/`g++` present:

| Check | Result |
|---|---|
| `npm ci --omit=dev` on bare alpine | **passed** |
| `npm install @node-rs/argon2` | **passed**, no node-gyp invoked |
| Prebuild selected | `@node-rs/argon2-linux-x64-musl` |
| Native binding loads and hashes | `$argon2id$v=19$m=19456,t=2,p=1$…` |

Two things worth carrying into implementation:

- **The library's defaults are already Argon2id at OWASP's recommended minimum** — 19 MiB memory, 2 iterations, parallelism 1. `PasswordHasherService` should call `hash()` with no options rather than inventing parameters.
- The check covered `--omit=dev`, so the **runtime** stage is proven too, not just the build stage. That matters because `@node-rs/argon2` is a production dependency and the runtime stage does its own install.

**Fallback, retained for the record and now unused:** had the prebuild failed, the fix was `apk add --no-cache python3 make g++` in the *build stage only*, leaving the runtime stage — and therefore the shipped image — clean.

**Plan Task 3 Step 2 still runs `docker build` after the real `npm install`.** Keep it. This verification used a synthetic install; the plan's check exercises the committed `package-lock.json`, which is the artifact CI actually builds.

**Test-suite consequence:** Argon2 is intentionally slow. Factories that do not exercise login must use a **precomputed hash constant**; only tests that actually verify a password may call the real hasher. Otherwise every fixture pays ~50–100 ms.

---

## 6. Tokens: lifetime and transport

Access tokens live **15 minutes**; refresh tokens **7 days**. Both come straight from foundation spec §7 and there is no repo-specific reason to deviate — short access lifetime bounds the damage of a leaked bearer token, and revocability lives in the refresh token, which is persisted and therefore killable.

Transport is the **JSON response body**, with `Authorization: Bearer` on subsequent requests, as fixed by foundation spec §1.

**On `CORS_ORIGIN=*`, which the brief flagged:** with tokens in the body and no cookies, `*` is **not** a credential-leak vector. The danger of a permissive origin is *ambient authority* — a browser attaching cookies automatically to a cross-origin request. A `Bearer` header is never attached automatically; a hostile page would have to already possess the token, at which point CORS is irrelevant. This would be a serious problem if we chose cookie transport. We are not, so deferring CORS tightening to Phase 6 remains correct.

New environment variables — `JWT_SECRET` (required, minimum length enforced), `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` — go into `.env.example` **and** the Joi schema in `src/config/env.validation.ts` in the same commit, per `CLAUDE.md`. They are surfaced through `AppConfig`; nothing outside `src/config/` reads `process.env`.

---

## 7. Roles: column now, guard in Phase 2

`Role` is an **enum column**, not a roles table. Phases 2–4 need exactly two roles: an admin who manages products, and a customer who places orders. A join table buys per-permission granularity that no phase in the roadmap requires, and the roadmap explicitly excludes multi-vendor. If per-permission grants ever appear, a table can be introduced then — that migration is additive.

**Deliberate deviation:** foundation spec §9 lists "guards, roles" under Phase 1, but **`RolesGuard` and `@Roles()` are deferred to Phase 2.**

Phase 1 has **no role-restricted endpoint**. `UsersModule` is service-only by §2's scope discipline, and `/auth/me` is callable by any authenticated user. Shipping `RolesGuard` now means shipping a security control with nothing to protect and no meaningful e2e test — testable only against a synthetic fixture route. This repository has now twice paid for "correct by inspection, unproven in use": the Dockerfile that had never been built, and `truncateAll()`, whose race only appeared once a second suite exercised it.

`User.role` **does** ship in Phase 1, because registration must assign a default and the column cannot be usefully backfilled with intent later. Phase 2 adds the guard **together with** `POST /api/v1/products` and a 403 e2e test that proves it.

**Blocker this deferral creates for Phase 2.** Nothing in Phase 1 can produce an `ADMIN`: registration hardcodes `CUSTOMER`, and no other code path writes `role`. So `RolesGuard` and an admin-bootstrap mechanism (seed script or one-off promotion) **must land in the same phase, and should land in the same change**. Shipping the guard without bootstrap gives a control that protects routes no real account can reach — verifiable only through `createUser(prisma, { role: Role.ADMIN })` in tests, which is precisely the untested-in-production pattern §7 defers the guard to avoid. It would also leave the live deployed API, a success criterion in foundation spec §1, with no administrator. Treat this as a Phase 2 entry condition, not a nice-to-have.

---

## 8. API surface

| Route | Auth | Success | Notes |
|---|---|---|---|
| `POST /api/v1/auth/register` | `@Public()` | 201 | Duplicate email → 409 via P2002 |
| `POST /api/v1/auth/login` | `@Public()` | 200 | Invalid credentials → 401 |
| `POST /api/v1/auth/refresh` | `@Public()` | 200 | Rotates; reuse revokes family |
| `POST /api/v1/auth/logout` | authenticated | 204 | Revokes the family |
| `GET /api/v1/auth/me` | authenticated | 200 | `UserResponseDto` |

**`POST /auth/refresh` must be `@Public()`.** By definition the caller's access token has expired — that is why they are refreshing. The refresh token is the credential and is validated inside the service, not by the guard. Marking this route protected locks every user out permanently, and it is an easy mistake to make precisely because the endpoint *feels* like it should be authenticated.

**Login must not leak which factor failed.** Unknown email and wrong password return an identical 401 with identical body and comparable timing. Otherwise login becomes an email-enumeration oracle.

**User enumeration on registration — flagged, not solved.** A duplicate registration returns 409, which reveals that an address is registered. Eliminating this requires always returning 201 and moving verification to email, which needs mail infrastructure that exists in no phase of the roadmap. For a Swagger-documented portfolio API where the registration endpoint is public and self-describing anyway, accepting the 409 is the right trade — but it is a conscious decision, not an oversight.

Every endpoint carries `@ApiTags`, `@ApiOperation`, `@ApiResponse`; protected routes add `@ApiBearerAuth()` so Swagger attaches the token. Controllers never return Prisma objects — each response DTO defines a static `from()` mapper, because `@Exclude()` silently no-ops on Prisma's plain objects (`CLAUDE.md`).

### Module boundaries

`UsersModule` owns `User` and exports `UsersService` (`findByEmail`, `findById`, `create`) with **no controller**. `AuthModule` owns `RefreshToken`, hashing, tokens, and guards, and depends on `UsersService`. This is foundation spec §2 verbatim; the rationale is that Phase 4 needs a user's email for receipts without transitively importing the JWT stack.

### Where `@Public()` and `JwtAuthGuard` live

**Deliberate deviation.** Foundation spec §2's directory sketch places `jwt-auth.guard.ts`, `roles.guard.ts`, `public.decorator.ts`, `roles.decorator.ts`, and `current-user.decorator.ts` together under `src/common/`. Phase 1 splits them:

| File | Location | Why |
|---|---|---|
| `@Public()` | `src/common/decorators/public.decorator.ts` | Consumed by `HealthModule` and the ping fixture |
| `JwtAuthGuard` | `src/modules/auth/guards/jwt-auth.guard.ts` | Injects `TokenService` |

The split is forced by dependency direction, and each half fails in the opposite way if placed with the other.

Putting `@Public()` in `AuthModule` breaks a `CLAUDE.md` rule outright. The global guard means `/health` and `test/fixtures/ping.module.ts` must both opt out, so both must import the decorator — and `CLAUDE.md` states a module may depend on other modules only "through NestJS module imports — **never by reaching into another module's internal files directly**." `HealthModule` importing `src/modules/auth/decorators/…` is exactly that. The decorator itself is `SetMetadata(IS_PUBLIC_KEY, true)`: no auth dependency, no domain logic, consumed by unrelated modules. That is the definition of cross-cutting, and `CLAUDE.md` already lists guards and decorators as `src/common/` material.

Putting `JwtAuthGuard` in `common/` inverts the layering instead. It injects `TokenService`, so `src/common/` — the cross-cutting layer every module depends on — would depend on a feature module. That is a worse violation than the one it would fix, and no rule in `CLAUDE.md` requires guards to live in `common/`; the rule constrains what may go *in* `common/`, not where guards must live. `app.module.ts` is the only file that references the guard, and as the composition root it is entitled to wire anything.

**What this costs:** the two pieces of one mechanism sit in different directories, and the guard's import reads `'../../../common/decorators/public.decorator'`. No path aliases are configured in `tsconfig.json`, and adding them is out of scope for this phase.

**Consequence for Phase 2.** `RolesGuard` follows `JwtAuthGuard` into `src/modules/auth/guards/`; `@Roles()` follows `@Public()` into `src/common/decorators/` if any module outside `auth` consumes it, and stays in `auth` if not. Apply the same test — dependency direction, not symmetry.

### Guard registration order

`ThrottlerGuard` and `JwtAuthGuard` are both registered as `APP_GUARD`. **Nest executes global guards in registration order**, so `ThrottlerGuard` is registered first: an unauthenticated flood should be rejected before any token parsing or database work happens. Registering them the other way means a credential-stuffing run does full auth work on every request before being throttled.

`JwtAuthGuard` fails **closed** — a route with no decorator is protected. Foundation spec §2 requires an e2e regression test that calls a protected route with no token and asserts 401, specifically to catch a future refactor dropping the `APP_GUARD` provider.

---

## 9. Throttling

`@nestjs/throttler` with in-memory storage, per foundation spec §7. Phase 5 swaps the backend to Redis so limits hold across instances; until then limits are per-process, which is honest for a single-instance deployment.

| Scope | Limit |
|---|---|
| Global default | 100 requests / 60 s |
| `register`, `login`, `refresh` | 5 requests / 60 s |

Implemented with named throttlers — `ThrottlerModule.forRoot([...])` plus a `@Throttle()` override on the auth routes. The global limit is deliberately generous: it exists to stop accidental hammering, not to shape traffic. The auth limit is tight because those three routes are the credential-stuffing surface.

**Known limitation, deferred:** the throttler keys on client IP. Behind a PaaS load balancer every request appears to originate from the proxy, collapsing all users into one bucket. Fixing this requires trusting `X-Forwarded-For`, which is a deployment concern and belongs with Phase 6's hosting work. Recorded here so Phase 6 does not rediscover it in production.

---

## 10. Testing strategy

Per `CLAUDE.md` and foundation spec §8. Unit tests for every service with `PrismaService` mocked. E2E against the dockerized Postgres on 5433. **The e2e suite runs serially (`maxWorkers: 1`)** — no test may assume worker isolation, and none needs to.

`test/factories/` arrives here, holding a user factory. Per `CLAUDE.md`, factories **insert through the Prisma client, never `$executeRaw`/`$queryRaw`**: `uuid(7)` is generated client-side and the migration emits a bare `TEXT NOT NULL` id with no database default, so a raw insert produces a row with no id.

Required e2e coverage:

- The 401 regression test mandated by foundation spec §2.
- Register → login → `/auth/me` happy path.
- Duplicate registration → 409.
- Login with unknown email and with wrong password → identical 401.
- Refresh rotates and invalidates the presented token.
- **Reuse of a consumed refresh token revokes the family** — the core security property of §3.
- Logout revokes the family; a subsequent refresh fails.
- Auth-route throttling returns 429 in the standard error shape.

---

## 11. First real exercise of untested foundation primitives

Phase F shipped primitives that are correct by inspection but, in several cases, have never run in anger. Phase 1 is where that changes — and, on this repository's recent record, where the surprises will be.

| Primitive | Status entering Phase 1 | First exercised by |
|---|---|---|
| **P2002** mapping → 409 | Unit-tested only; never triggered by a request | Duplicate registration on `User.email` |
| **P2025** mapping → 404 | Unit-tested only | Update/delete against a missing token row |
| **`truncateAll()` across a foreign key** | The throwaway probe had **no relations** | `TRUNCATE … CASCADE` over `users` → `refresh_tokens` |
| **First *committed* migration** | The throwaway proved the mechanism, then was reverted | The `User`/`RefreshToken` migration, replayed from scratch in CI on every run |
| **`test/factories/`** | Does not exist | The user factory, plus the `uuid(7)` client-side rule |
| **Docker build with a native-ish dependency** | Has only ever built pure JS | `@node-rs/argon2` musl prebuild resolution |
| **`HttpExceptionFilter` on non-validation errors** | Has shaped validation errors and unit-test inputs only | Guard-origin 401s and throttler 429s |
| **Serialized e2e under real load** | 3 suites, one touching tables | Several DB-heavy auth suites in strict series |

**Explicitly still unproven after Phase 1:** `PaginationQueryDto`, `PaginatedDto`, and `@ApiPaginatedResponse` have **zero consumers** and gain none here — Phase 1 has no list endpoint, because `UsersModule` ships without a controller. They wait for Phase 2. **P2003** (foreign-key violation) likewise probably stays untriggered, since `onDelete: Cascade` handles the only deletion path Phase 1 creates. The foundation is not fully validated at the end of Phase 1, and this document should not be read as claiming otherwise.

**Instruction for Phase 2 — reshape the DTO, not the endpoint.** These three were written against no real query. When the first list endpoint arrives and the DTO does not fit what it actually needs — sort contract, filter shape, or the offset/cursor decision — **change the DTO**. Do not contort the endpoint to preserve a speculatively-written shape. Nothing depends on them yet, so the cost of changing them is currently zero and will never be lower. (Note that moving from offset to cursor would also amend foundation spec §5, which chose offset deliberately; that is a spec change, not a silent DTO edit.)

---

## 12. Task ordering

1. **Env + config** — `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` into `.env.example` *and* the Joi schema in one commit; extend `AppConfig`.
2. **Schema + first migration** — `Role`, `User`, `RefreshToken`.
3. **`test/factories/`** — user factory via the Prisma client, precomputed password hash.
4. **`UsersModule`** (service-only) + unit tests.
5. **Password hasher** wrapping `@node-rs/argon2` + unit tests. *Verify `docker build` here, before going further.*
6. **Token service** — JWT sign/verify; refresh generate, SHA-256 hash, rotate + unit tests.
7. **`AuthService`** — register, login, refresh with reuse detection, logout + unit tests.
8. **Auth controller + DTOs** — request DTOs, response DTOs with static `from()`, Swagger decorators.
9. **Global `JwtAuthGuard`** via `APP_GUARD` + `@Public()` + **the mandatory 401 regression test**.
10. **Throttler** — global + auth overrides + a 429 e2e assertion through `HttpExceptionFilter`.
11. **Full auth e2e** — the §10 list, especially family revocation on reuse.
12. **Docs** — `CLAUDE.md` (Argon2-for-passwords / SHA-256-for-tokens, the `RolesGuard` deferral) and `README`.

The guard lands at step 9, immediately after the controller, so it has a real route to protect and the 401 test is meaningful rather than synthetic. Steps 1–3 are ordered so the first migration exists before anything depends on it, which is also what forces `global-setup.ts` down its `prisma migrate deploy` branch for the first time in a committed state.

---

## 13. Resolved decisions

These three were flagged for a reviewer during design and are now settled. They are recorded here because the implementation plan already encodes them, and a spec that still called them open would disagree with the plan about its own state.

### 13.1 Registration returns tokens — **yes**

`POST /auth/register` returns an access + refresh pair alongside the user, so a new account is logged in immediately (201 with `AuthResponseDto`).

The alternative — 201 with the user only, forcing a separate `POST /auth/login` — is marginally more conventional. It was rejected because it makes the Swagger demo path two calls instead of one for no security gain: the caller just proved possession of the password microseconds earlier, so issuing tokens reveals nothing a subsequent login would not. Low stakes either way; this is the more usable of two defensible options.

**Implemented by:** plan Task 9, `AuthController.register` → `AuthResponseDto`.

### 13.2 Expired token cleanup — **deferred to Phase 5**

Expired and revoked `RefreshToken` rows accumulate with no purge. This is a **conscious deferral, not an oversight**: a scheduled purge is natural BullMQ work, and BullMQ arrives in Phase 5.

Nothing breaks in the meantime. Rows are only ever looked up by `tokenHash` (unique index) or `familyId` (indexed), so query cost does not degrade with table size — this is a disk-growth concern, not a correctness or latency one, and at portfolio traffic the table will not reach a size worth managing. Recorded as a known unbounded-growth table so Phase 5 does not have to rediscover it.

**Owner:** Phase 5.

### 13.3 `JWT_SECRET` minimum length — **32 characters**

Enforced by Joi: `JWT_SECRET: Joi.string().min(32).required()`.

The floor is a round number rather than a derived one, but it is defensible: HS256 keys should carry at least as much entropy as the 256-bit digest they feed, and 32 characters is the shortest length at which a human-chosen-looking string plausibly clears that bar. `required()` matters more than the exact floor — it is what makes boot fail loudly rather than signing tokens with a weak or absent secret.

**Consequence, already handled:** CI has no `.env`, so the e2e job must set `JWT_SECRET` in its `env:` block, in the same commit that makes it `required()` — per `CLAUDE.md`'s rule that a new env var lands in `.env.example` and the Joi schema together. Plan Task 1 Step 7 does this.

**Implemented by:** plan Task 1.

---

## 14. How migrations will run in the deployed image

Foundation spec §10 requires `prisma migrate deploy` to run **as a discrete release command, never at application boot** — running migrations at boot races across replicas and couples schema changes to process start. Phase 1 creates the project's first committed migration, which is what makes this question real, so the mechanism is settled here and implemented in Phase 6.

### ✅ Verified 2026-08-13 — the shipped image can already run migrations

The `prisma` CLI is a `devDependency` and the runtime stage runs `npm ci --omit=dev`, so the natural assumption is that the CLI is absent from the deploy unit. **That assumption is wrong, and it was tested rather than reasoned about.** Probing the real built image:

| Check | Result |
|---|---|
| `npx prisma --version` | `prisma 6.19.3`, `@prisma/client 6.19.3` |
| `npx prisma migrate deploy --help` | resolves — the command is reachable |
| Query engine | `libquery_engine-linux-musl-openssl-3.0.x.so.node` present |
| Schema | loaded from `prisma/schema.prisma` (`COPY prisma ./prisma` works) |

**Why it survives `--omit=dev`:** `@prisma/client` declares `prisma` as an **optional peer dependency**. npm installs optional peers even when dev dependencies are omitted, which is why `package-lock.json` marks `node_modules/prisma` as `"devOptional": true` rather than `"dev": true`. `@prisma/engines` comes along as its dependency.

### The decision: make it explicit in Phase 6

Working and *intentionally* working are different things. The current behaviour rests on three things this project does not control:

- Prisma continuing to declare `prisma` as an optional peer of `@prisma/client`
- npm continuing to install optional peers under `--omit=dev`
- nobody adding `--omit=optional` or `--no-optional` to the Dockerfile

Any of those changing turns a green build into a release command that fails at deploy time, with nothing in CI to catch it. So: **move `prisma` from `devDependencies` to `dependencies` in Phase 6**, which declares the dependency the release command actually has instead of inheriting it by accident. This is hardening, not a fix — priority is low, and nothing blocks on it.

| Option | Verdict |
|---|---|
| **Declare `prisma` in `dependencies`** | **Chosen** — states the real requirement; ~0 MB change, it is already installed |
| Rely on the optional-peer transitive as-is | Rejected — works today, undeclared, silently breakable |
| `npx prisma@6.19.3 migrate deploy` at release | Rejected — needs network at release, re-downloads per deploy, and the pinned version drifts from `package-lock.json` on the first Prisma upgrade |
| A separate migration image or stage | Rejected — real operational complexity for a single-service deployment |

### Phase 6 checklist

1. Move `prisma` from `devDependencies` to `dependencies` in `package.json`. Image size is unaffected — it is already being installed.
2. Configure the host's release command as `npx prisma migrate deploy`, resolving to the local install rather than the network.
3. Add a CI step that **runs** the built image and probes `/health`. The `docker` job currently builds and discards, so nothing proves the deploy unit boots.

Item 3 is the durable fix. This section had to be corrected once already because the image had never been executed anywhere — the original text asserted the CLI was missing, which one `docker run` disproved. Build-only CI produces exactly that class of confident, wrong claim.

---

## 15. Token crypto: algorithm, payload, and failure handling

Task 6 (`TokenService`) left three things implicit rather than decided: the signing algorithm, the exact payload, and what a verification failure looks like to callers. None of these are deviations from the foundation spec — it does not specify them — so this section fills a gap rather than overriding a prior decision, the same relationship §5 has to foundation spec §7.

### 15.1 Signing algorithm: HS256

Symmetric, one shared `JWT_SECRET`. This is not a new decision so much as making explicit what `JwtModule.register({ secret })` already implies by library default — but it is worth stating, because the alternative is a real design, not a formality.

**Rejected: RS256/ES256 (asymmetric).** The argument for a keypair is letting a party other than the signer verify tokens without holding the signing secret — typically because a separate service or gateway needs to validate tokens independently. Nothing in the roadmap through Phase 6 describes that: this is a single deployed service with managed Postgres and Redis, not a service mesh. Asymmetric signing would add key generation, PEM storage, and a rotation story for a capability nothing here uses. `HS256` matches the configuration Task 1 already built — one secret, no keypair.

### 15.2 Access token payload: `{ sub, role }`

The original Task 6 draft carried `{ sub, email, role }`. `email` is removed.

**This was verified, not assumed.** Every consumer of `AuthenticatedUser`/`request.user` in the implementation plan was checked by direct search: `AuthService.logout` and `AuthController.me` both read only `.sub`; nothing reads `.email` off the token anywhere. `GET /auth/me` (Task 9) returns the user's email by refetching the full row from the database via `usersService.findById(request.user.sub)` — the JWT's copy is never consulted. `UserResponseDto` and `AuthResponseDto` populate `email` from that same database row, not from the token, so this change has no effect on any response body.

**Why remove a claim nothing reads:** a bearer token is not confined to the application's own logs. It routinely surfaces in places `CLAUDE.md`'s "never log tokens" rule cannot reach — proxy and CDN access logs, browser devtools network history, error-tracker request breadcrumbs. Every claim in the payload is PII carried into all of those places by construction. An unused claim is pure downside: no functionality depends on it, and removing it shrinks that surface for free. Re-adding it later, if a real consumer appears, costs nothing beyond editing one object literal — JWTs are not a persisted schema, and no migration or backfill is involved. Tokens already in flight without the claim simply expire within 15 minutes.

**`role` is kept, and this is not the same argument in reverse.** `role` is also unread by any Phase 1 code today, but unlike `email` it has a concrete, already-documented near-term consumer: Phase 2's `RolesGuard` (named in §7 and the Phase 2 blocker note) will read `request.user.role` to authorize routes without a Prisma lookup on every request — the standard reason an authorization claim belongs in the token at all. Keeping `role` is provisioning for a documented next phase; keeping `email` would have been provisioning for nothing on record.

### 15.3 Verification failures propagate unwrapped

`TokenService.verifyAccessToken` does not catch or rewrap the underlying `@nestjs/jwt` error. It throws whatever the library throws.

**This was checked against the actual consumer, not decided in isolation.** Task 10's `JwtAuthGuard` was read before this call: it wraps every call to `verifyAccessToken` in a bare `try { … } catch { throw new UnauthorizedException(); }`, with a comment stating the intent directly — expired, tampered, and wrong-secret tokens are all just "unauthorized." The guard does not branch on error type. A `TokenService`-owned exception (e.g. `InvalidTokenError`) would have exactly one caller, and that caller already discards everything the wrapper would carry. Building it now is provisioning for a distinction nothing in this phase draws — the same category of speculative generality §7 and §8 already reject elsewhere in this document.

**The plan's original test was still too weak to keep as written.** `rejects.toBeDefined()` passes even if the method rejected with a bare string rather than an `Error`. Tightened to `rejects.toBeInstanceOf(Error)` — a one-line change that costs nothing and catches a real code smell (throwing a non-`Error` value) that the previous assertion could not.

### 15.4 Confirmed unchanged

Access token lifetime (15 minutes, §6), refresh token generation (`randomBytes(32)` via `node:crypto`, a CSPRNG, base64url-encoded — §4.2), and refresh token hashing (SHA-256, §4.2) were all re-examined against this section's questions and found already correctly decided with rationale on record. `TokenService`'s no-Prisma boundary — it accepts an already-fetched `User` and never imports `PrismaService` — was likewise confirmed as already correct in the Task 6 draft. Nothing in this section changes any of the four.
