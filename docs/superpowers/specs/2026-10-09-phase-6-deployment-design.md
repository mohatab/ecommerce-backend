# Phase 6 — Deployment

Design spec. Authority for the phase: where this document and a task brief
disagree, this document wins until it is amended.

Status: approved for planning. Decisions D1–D10 are locked by the brainstorming
proposal of 2026-10-09 and may not be changed by an implementer. A locked
decision changes only by amending this section with the repository evidence that
forced it.

---

## 1. Objective

Make the shipped artifact **verified** rather than merely **built**, and settle
the one security decision this repository has explicitly deferred to this phase.

Phase 6 is not "deploy to a host". It is:

> The image starts, migrates, serves, and stops — proven in CI, reproducible
> locally — and the trusted-proxy question is answered deliberately rather than
> guessed.

The repository already scopes this phase itself. `README.md:32` reads:

> ⬜ Deployment: container smoke test, trusted-proxy configuration,
> release/migration process

Three items. Two of them are additionally owned by `docs/deferred-limitations.md`
entries carrying `Owner: Phase 6`, and the CI workflow hands the third over in
its own comments:

- `.github/workflows/ci.yml`, `docker` job: *"Build only: no tag push, no
  registry login, no publish — that belongs to Phase 6."*
- `.github/workflows/ci.yml`, `bootstrap` job: *"What it deliberately does NOT
  prove: that the Docker runtime image starts, connects, and serves."*

So the work is not invented here. It is collected.

### 1.1 What this phase deliberately is not

It is not an infrastructure rewrite. It adds **zero runtime dependencies** and
**zero migrations**. The single largest risk to the phase is scope: a deployment
phase invites Kubernetes, a registry, a log pipeline, and a cache, none of which
has a consumer in this repository. §2.2 names each exclusion with its reason.

---

## 2. Scope

### 2.1 In scope

1. Liveness/readiness split and probe semantics (§6).
2. Trusted-proxy configuration and policy (§5).
3. Production configuration guards (§7) and Swagger gating (§8).
4. A migration image built from the same build as the runtime image (§9).
5. A Docker runtime smoke test that runs the real artifact (§10).
6. Compose `app` and `migrate` services for local reproducibility (§11).
7. CI workflow changes, including the container→database network (§12).
8. SIGTERM/shutdown verification (§13).
9. Documentation: a release runbook, `deferred-limitations.md` updates,
   `CLAUDE.md` Phase 6 section (§18, T7).

### 2.2 Out of scope, with reasons

Each exclusion is a decision, not an omission. The common reason: **no real host
exists**, so building any of these produces aspirational, unrun configuration —
precisely the untested-artifact problem this phase exists to eliminate.

| Excluded | Why |
|---|---|
| Kubernetes, Helm, operators | One container. An orchestrator with one workload is configuration with no reader. |
| Registry publish / image tagging | Nothing exists to pull the image. D10. |
| TLS termination, certificates | Owned by the proxy, which is declared not deployed. |
| A real host (VPS/PaaS/cloud) | D1. The artifact is verified, not deployed. |
| Redis / BullMQ | D2, and §14.4 gives the full argument plus the trigger that would reverse it. |
| Structured JSON logging, correlation ids, metrics, tracing | D9. A logging *subsystem* is not deployment work, and `main.ts` cannot read `process.env` for a log level without breaking the `src/config/`-only rule. §16 states the trigger. |
| Backup/restore, PITR | No durable data exists outside a dev volume. |
| Blue-green, canary, autoscaling | Requires ≥2 instances. D1 says one. |
| Mid-sweep shutdown drain | §13.4. Testing it is a flake factory; the property is documented and deferred instead. |
| Multi-instance | D1. §14.3 states exactly what would change. |
| A least-privilege database role for the application, separate from the migration role | §9.2. It is what would turn the CLI-absence *tooling* boundary into a real *capability* boundary, and it is a database administration decision needing a migration story for existing deployments. Recorded as a deferred limitation (§19.3, item 8), not built. |

### 2.3 Scope boundary with Phase 5

Phase 5's authority is untouched. Phase 6 adds **no** new maintenance job, changes
**no** sweep, touches **no** lease logic, and writes **no** new table. Its only
contact with Phase 5 is observational: §14 documents scheduler behaviour under the
deployed topology and asserts in the smoke test that cron registration works
inside the real image — something currently proven only in unit tests.

Phase 4's central invariant is likewise untouched: `markPaid()` remains the only
writer of `OrderStatus.PAID`, and `PaymentWebhookService` its only caller. Phase 6
adds no route and no provider method.

---

## 3. Locked decisions

| # | Decision | Rationale anchor |
|---|---|---|
| **D1** | **Topology: one app instance, one reverse-proxy hop, declared not deployed.** The reference topology for design validation and tests. | §5 |
| **D2** | **No Redis, no BullMQ.** In-memory throttler storage is *correct* at one instance. Sharpen the deferred entry with a number and a named decision instead. | §14.4 |
| **D3** | **Migration delivery: a separate `migrate` stage built from the same Dockerfile and source commit.** Not promoting the `prisma` CLI to a production dependency. *(Wording only: an earlier draft said "the same `docker build`". The build is two `--target` invocations sharing one Dockerfile, one commit, and one context — §9.1. The decision is unchanged.)* | §9 |
| **D4** | **`TRUST_PROXY_HOPS` is required under `NODE_ENV=production`, with no default.** | §5.3 |
| **D5** | **Add `/health/live` (unthrottled, zero I/O). Leave `/health` exactly as it is** — DB check and throttle included. | §6 |
| **D6** | **Swagger gated on `NODE_ENV === 'production'`. No new environment variable.** | §8 |
| **D7** | **`CORS_ORIGIN='*'` forbidden under production.** Recorded as the weakest of the guards; see §7.3. | §7.3 |
| **D8** | **One compose file.** Add `app` and `migrate` services; no second production-shaped compose file. | §11 |
| **D9** | **Observability: `TZ=UTC` and a boot topology log only.** Structured logging deferred. | §16 |
| **D10** | **No registry publish.** | §2.2 |

---

## 4. Current state and verified gaps

Read out of the repository on 2026-10-09 at `master` = `ba59a2a`. Every row below
cites the file that establishes it. Rows are **verified gaps**, not suspicions.

### 4.1 What exists today

`node dist/main` in a `node:20-alpine` image, non-root (`USER app`), built by CI
and **never run**. Postgres in compose for development (5432) and e2e (5433, tmpfs).
One `/health` endpoint performing a database query. No proxy awareness anywhere.
Migrations applied by a human from a checkout.

### 4.2 Verified gaps

| # | Gap | Evidence |
|---|---|---|
| **G1** | Compose defines no `app` service. The image is never run — not in compose, not in CI. | `docker-compose.yml`: only `postgres`, `postgres-test` |
| **G2** | CI builds the image and stops. | `ci.yml` `docker` job is `docker build -t ecommerce-backend:ci .` and nothing else |
| **G3** | No trusted-proxy handling of any kind. | `grep 'trust proxy\|trustProxy\|x-forwarded'` over `src/` and `test/` → **zero hits**. `getHttpAdapter` and `NestExpressApplication` are likewise unused |
| **G4** | `/health` is a single DB-querying endpoint and is itself rate-limited; liveness and readiness are conflated. | `health.controller.ts` runs `` $queryRaw`SELECT 1` `` → 503 on failure. `app.module.ts`'s own comment: *"a load balancer probing faster than ~1.7/s from a single source will start seeing 429s — confirm that is acceptable before deploying behind one."* |
| **G5** | The `prisma` CLI is absent from the runtime image, so `migrate deploy` cannot run from the shipped artifact. | `package.json`: `prisma` is a devDependency; `Dockerfile` runtime stage runs `npm ci --omit=dev`. Generated client arrives by copying `node_modules/.prisma`, a layout Prisma does not contract |
| **G6** | No `HEALTHCHECK`, and the signal path is untested. | `Dockerfile` `CMD ["node", "dist/main"]` → node is PID 1. `configureApp()` does call `app.enableShutdownHooks()`, but **zero tests reference `SIGTERM`, `SIGINT`, or shutdown**: those strings appear only in `src/bootstrap.ts` and a `maintenance.scheduler.ts` comment |
| **G7** | Swagger is published unconditionally, outside the Nest guard chain. | `main.ts` calls `SwaggerModule.setup('api/docs', …)` with no environment check |
| **G8** | `CORS_ORIGIN` defaults to `*` with no production override. | `env.validation.ts`: `CORS_ORIGIN: Joi.string().default('*')` — while `PAYMENT_PROVIDER` directly above demonstrates the in-repo pattern for forbidding a value under production |
| **G9** | `.dockerignore` omits `docs/`, `test/`, `.superpowers/`, `.claude/`, so `COPY . .` pulls the **gitignored** SDD ledger into the build layer. | `.dockerignore` lists only `node_modules`, `dist`, `coverage`, `.env`, `.env.*.local`, `.git`, `*.log` |
| **G10** | Default Nest pretty-text logs; no request log, no correlation id, no level configuration. | `main.ts`, `bootstrap.ts` |
| **G11** | No `TZ` pinned, so the purge's "03:00" is undeclared. | `Dockerfile` sets only `NODE_ENV`; `MAINTENANCE_PURGE_CRON=0 0 3 * * *` |
| **G12** | The lease holder is a per-process `randomUUID()` — multi-instance-*safe* already, but logs cannot say *which container* holds a lease. | `maintenance-lease.service.ts:37` |

### 4.3 Two suspicions disproved by inspection

Recorded so no implementer re-litigates them:

- **Gating Swagger cannot break the OpenAPI inventory test.** `swagger.e2e-spec.ts`
  builds its own document via `SwaggerModule.createDocument` and never requests
  `/api/docs`. No test anywhere references that path.
- **No custom throttler tracker is needed.** `@nestjs/throttler@6.5.0`'s
  `ThrottlerGuard.getTracker()` returns bare `req.ip`
  (`node_modules/@nestjs/throttler/dist/throttler.guard.js:141-143`), and Express's
  `req.ip` honours `trust proxy`. One `app.set()` is the entire mechanism. Do not
  subclass the guard.

### 4.4 The gap interaction that matters most

G3 ∩ G4 compounds. Behind a proxy with no `trust proxy`, Express reports the
*proxy's* address for every request, so **every client and the load balancer's own
health probes share a single throttle bucket**. The probe traffic alone can consume
the 100/minute budget that protects a route; and the 5/minute budget on `login`
becomes 5/minute for the entire internet. Neither failure is loud. This is why §5
and §6 are the same phase.

---

## 5. Topology and trust-proxy policy

### 5.1 The reference topology

```
client ──▶ [ one reverse proxy: TLS, X-Forwarded-For ] ──▶ [ app container ] ──▶ [ postgres ]
                                                            API + in-process cron    volume
```

One app instance. One proxy hop. Declared, not deployed.

Single instance is not a shortcut: it is what makes in-memory throttling *correct*
(§14.4) and the hop count *knowable*. Phase 5 already made the scheduler
multi-instance-safe through the `maintenance_leases` row, so scaling out later is a
configuration change, not a redesign.

### 5.2 One hop is the reference value, never a universal one

**This is a hard rule, and the most likely thing for a future reader to get wrong.**

The one-hop topology above is the **reference topology for design validation and
tests**. It is *not* a production default and *not* a value to hardcode.

- `TRUST_PROXY_HOPS` must be set **per deployment**, to match that deployment's
  actual proxy chain depth.
- Tests fix the value to `1` because a test needs *some* topology to assert
  against. That choice is local to the test, injected by the test, and carries no
  authority over any deployment.
- The prohibition is precise, and **is not a repository-wide ban on the number
  `1`**. What is forbidden: `1` as a production default, as a fallback in
  application or configuration code, or as a README value presented as universal
  or recommended. What is **permitted and expected**: a test setting `1`
  explicitly to exercise this reference topology (C-D1, C-D2), and documentation
  that labels `1` as the reference topology while naming `0` and `2` as equally
  correct for other chains. DoD item 15 breaks this into four checkable parts.
- `.env.example` carries `TRUST_PROXY_HOPS=0`, with the comment explaining that
  the correct value is the number of proxies that will append to
  `X-Forwarded-For`.
- A deployment behind two proxies (a CDN in front of a load balancer, say) needs
  `2`, and a direct-to-Node deployment needs `0`. Both are correct configurations
  of the same code.

### 5.3 The policy: a hop count, required under production

A new variable, `TRUST_PROXY_HOPS` — a non-negative integer. Default `0` in
development and test; **required, with no default, under `NODE_ENV=production`**
(D4).

**Why a numeric count and never `trust proxy: true`.** Express's `true` makes it
take the **leftmost** `X-Forwarded-For` entry, which is entirely attacker-supplied.
This repository's tightest control is 5 requests/minute on `login`; under `true`
that control becomes *unlimited*, because a caller rotating the header mints a
fresh bucket per request. A numeric `N` counts from the **right**, skipping exactly
as many entries as there are proxies that will append — so entries a client forged
are skipped by construction.

**Why required rather than defaulted.** Neither default is safe:

- `0` behind a proxy collapses every client into one bucket — a trivial denial of
  service against all users at once, made worse here by G4 ∩ G3 (§4.4).
- Anything higher than the real hop count is a full bypass: Express counts past the
  proxy-appended entries into attacker-supplied ones.

Both directions are bad, and **which one is worse depends on the topology, which
the code cannot know**. This is the same shape as Phase 5's recorded finding that
there is no universal fail-closed direction when two consumers read a value
oppositely. The only honest resolution is to forbid a default and make the deployer
state the topology — which is exactly what `deferred-limitations.md` already asks
for: *"Whoever deploys this must set it deliberately."*

Note the asymmetry for the runbook: **too high is the dangerous direction.** Too
low degrades availability loudly (everyone throttled together); too high removes
the control silently.

### 5.4 Where it is applied

In `configureApp()` in `src/bootstrap.ts` — the established configuration seam.
This is required, not stylistic: `test/helpers/create-test-app.ts` calls
`configureApp()`, which is the only reason the §17 controls are e2e-testable at
all. Setting it in `main.ts` would make the production path and the test path
diverge, which is the exact failure `configureApp()` exists to prevent (see its
header comment and the `NEST_APP_OPTIONS` precedent).

Implementation shape, so the signature need not change:

```ts
app.getHttpAdapter().getInstance().set('trust proxy', hops);
```

`configureApp(app: INestApplication)` keeps its type. Changing it to
`NestExpressApplication` would ripple into the e2e harness's
`INestApplication<App>` typing for no benefit.

### 5.5 What it governs, and what it does not

It governs `req.ip`, and therefore every throttle bucket, because
`getTracker()` returns `req.ip` (§4.3). It does **not** retroactively make
`X-Forwarded-For` trustworthy for anything else, and nothing in this repository
reads that header directly. No request logging consumes `req.ip` today (G10), so
throttling is the sole consumer — which is why this phase's proxy work is small.

---

## 6. Liveness and readiness

### 6.1 The split

Add **`GET /health/live`** — process-only, zero I/O, `@Public()`, and
`@SkipThrottle()`. It answers one question: is this process up and able to serve a
request at all.

**Leave `GET /health` exactly as it is.** Same path, same database query, same 503
on failure, same Swagger decorators, same throttle. It is the readiness-shaped
check, it is already tested (`test/app.e2e-spec.ts`, `test/routing.e2e-spec.ts`),
and it is already documented in `README.md`. Phase 6 does not touch it.

### 6.2 Why the split is needed in *this* repository

Not because probe separation is good practice. Because of a specific, verifiable
failure mode:

`PrismaService.onModuleInit()` calls `$connect()`. A failure there propagates out
of module initialisation to `main.ts`'s `bootstrap().catch`, which calls
`process.exit(1)`.

So pointing a **liveness** probe at the database-touching `/health` converts a
transient database blip into an **unbootable crash loop**: the probe fails, the
orchestrator restarts the container, and the restart cannot succeed while the
database is still unreachable — whereas the *running* container would have
reconnected on its own through Prisma's pool. The restart actively prevents the
recovery that would otherwise have happened.

There is a second, Phase-5-specific cost to that crash loop: a container killed
mid-sweep does not run the runner's `finally` release, so its lease stays held
until `expiresAt` — up to `MAINTENANCE_LEASE_SECONDS` (default 300s). A crash loop
therefore converts a database blip into stalled maintenance as well as a stalled
API.

### 6.3 Why the throttle treatment is asymmetric

`/health/live` is `@SkipThrottle()`. `/health` stays throttled. This is deliberate
and the asymmetry is the point:

- `/health` is `@Public()` and costs a **database round trip** per request.
  Un-throttling it would build an unauthenticated database-load amplifier — a
  strictly worse exposure than the 429s G4 describes.
- `/health/live` costs nothing: no database, no I/O, no allocation worth naming.
  Skipping the throttle is free.

This resolves the hazard `app.module.ts` already names without opening a denial-of-service
hole. An implementer who "simplifies" by skipping the throttle on both has
reintroduced the amplifier.

### 6.4 Response shape

`/health/live` returns `200` with `{ "status": "ok" }`. It never returns 503: if
the process cannot answer, the request does not get a response at all, which is the
signal. Adding a failure branch would mean adding a check, and the whole point is
that it checks nothing.

`/health`'s existing shape — `{ status: 'ok', timestamp }` — is unchanged.

### 6.5 Probe assignment

| Consumer | Endpoint | Reason |
|---|---|---|
| Docker `HEALTHCHECK` | `/health/live` | Container liveness. §6.2 forbids tying restarts to the database |
| An orchestrator's readiness probe (when one exists) | `/health` | "Ready to receive traffic" genuinely requires the database |
| The §10 smoke test | **both** | `/health/live` proves the process serves; `/health` proves it connected |

---

## 7. Production configuration guards

### 7.1 Principle

This repository already establishes that the worst realistic misconfiguration
**aborts boot** rather than failing at first request — `PAYMENT_PROVIDER=fake`
under `NODE_ENV=production` is rejected by Joi, at boot, by design. Phase 6 adds
two guards in that same family and pins one Docker-level value.

### 7.2 The Joi mechanics, measured

The `PAYMENT_PROVIDER` schema carries a warning that a `then` branch is
**concatenated** onto the base schema, which is why `Joi.override` is load-bearing
there: a bare `Joi.valid('stripe')` would *add* `'stripe'` to the already-allowed
set and leave `'fake'` just as valid.

That trap is specific to allow-list concatenation. `required()` and `invalid()` do
not share it. Verified empirically against the installed `joi` before writing this
spec, all eight cases:

| Schema | Input | Result |
|---|---|---|
| `number().integer().min(0).default(0).when(NODE_ENV=production → required())` | production, unset | **rejected**: `"X" is required` |
| same | production, `'2'` | accepted, coerced to `2` |
| same | development, unset | accepted, `0` |
| `string().default('*').when(NODE_ENV=production → string().invalid('*').required())` | production, `'*'` | **rejected**: `contains an invalid value` |
| same | production, `'https://a.test'` | accepted |
| same | production, unset | **rejected**: `is required` |
| same | development, unset | accepted, `'*'` |

So: `.default()` combined with a concatenated `then: required()` neither throws at
schema-build time nor leaks the default under production. No `Joi.override` is
needed for either guard. An implementer must still re-verify this rather than trust
the table — §17.1 makes it a required unit assertion.

### 7.3 The guards

**`TRUST_PROXY_HOPS` required under production** — §5.3. Highest value of the
three: it closes a documented security gap.

**`CORS_ORIGIN='*'` forbidden under production** (D7). Recorded honestly as **the
weakest guard in this phase**, and the spec says so rather than overselling it:
this API authenticates with bearer tokens, not cookies, so `*` leaks no credential
by itself and no browser will attach one automatically. What makes it worth
forbidding is the combination with G7: a wildcard origin plus a published admin
surface lets any origin script admin routes with a token obtained some other way.
Under production, `CORS_ORIGIN` becomes required and `'*'` becomes invalid. If a
future deployment genuinely needs a wildcard it must say so by amending this spec,
which is the intended friction.

**`TZ=UTC` pinned in the Dockerfile** (G11). Not a Joi guard — an `ENV` line. The
purge runs `0 0 3 * * *` and alpine defaults to UTC, so this does not *change*
behaviour; it **declares** it, so "03:00" in the runbook is unambiguous and a base
image that someday ships a different default cannot move the purge silently.

### 7.4 The boot topology log

One log line at boot, after configuration resolves, naming what the container
thinks it is: `NODE_ENV`, `TRUST_PROXY_HOPS`, `MAINTENANCE_JOBS_ENABLED`,
`PAYMENT_PROVIDER`, and whether Swagger is served.

Roughly five lines of code. It answers the first question any operator asks of a
misbehaving container, and it is the entire observability content of this phase
(D9). It must log **no secret**: not `JWT_SECRET`, not `PAYMENT_API_KEY`, not
`PAYMENT_WEBHOOK_SECRET`, not `DATABASE_URL` (which embeds a password). The
existing "never log" rules are unchanged and this line is explicitly in their
scope.

---

## 8. Swagger production gating

`main.ts` mounts Swagger unconditionally (G7). Because `SwaggerModule.setup()`
installs Express middleware, it sits **outside the Nest guard chain** — neither
`JwtAuthGuard` nor `RolesGuard` applies. A production container therefore publishes
the complete API surface, including every admin route and
`POST /api/v1/admin/maintenance/:job/run`.

**Decision (D6): serve Swagger unless `NODE_ENV === 'production'`. No new
environment variable.**

A `SWAGGER_ENABLED` flag would be a configuration knob with no current consumer; if
a staging deployment later wants docs under a production `NODE_ENV`, adding the
variable then is a one-line change made for a real reason. Not inventing it now is
the smallest correct design.

Verified safe (§4.3): `swagger.e2e-spec.ts` constructs its own document and never
requests the route, so the 21/21 OpenAPI inventory assertion is unaffected. No test
anywhere references `/api/docs`.

The gate is asserted by a negative control in the container, not just in a unit
test — see C-D8. A unit test proves the branch; only running the image proves the
route is absent from the shipped artifact.

---

## 9. The migration image

### 9.1 Shape

**Two `docker build` invocations, one per target, against one Dockerfile and one
source commit.** Each invocation passes `--target`; both resolve the same
`build` stage, so the shared layers are built once and reused from the cache by
the second invocation.

- **`runtime`** — contents unchanged, plus `HEALTHCHECK` and `ENV TZ=UTC`.
- **`migrate`** — new: `FROM build AS migrate`, with `CMD` running
  `prisma migrate deploy`. Two lines. The `build` stage already carries
  devDependencies, the `prisma` CLI, `prisma/schema.prisma`, and
  `prisma/migrations`.

The invariant that matters is **one Dockerfile, one source commit, one build
context** — not a literal single command. §9.4 lists the exact commands and they
are what an implementer follows.

**Do not introduce `buildx`, Bake, or any other tool merely to make a single
command produce both tags.** That would add a dependency to preserve a phrase.
Two plain `docker build --target` invocations satisfy the invariant with the
toolchain already present on every runner.

### 9.2 Why a separate stage rather than promoting the CLI

Promoting `prisma` to a production dependency would also close G5, so the choice
needs a reason beyond image size.

**The serving image carries no migration tooling**, so applying a migration from a
serving container is not something an operator or a stray script can do by
reaching for the documented command. C-D10 asserts that mechanically (§17.3)
rather than leaving it to prose.

**State this precisely — an earlier draft of this spec overclaimed it, and the
overclaim is corrected here rather than quietly dropped.**

What C-D10 establishes: **the standard Prisma migration CLI is absent from the
runtime image**, so `prisma migrate deploy` and its siblings cannot be invoked
there.

What C-D10 does **not** establish, and what no part of Phase 6 establishes:

- It does not prove schema mutation is *impossible*. `PrismaService` extends
  `PrismaClient`, which exposes `$executeRaw` and `$executeRawUnsafe` (both present
  on the generated client, verified). Application code issuing DDL through either
  would alter the schema with no CLI involved. Today it does not: the only raw SQL
  anywhere in `src/` is the health check's `` $queryRaw`SELECT 1` ``, and there is
  no DDL. So this is a **latent capability, not an exercised one** — which is a
  reason the gap is acceptable, and not a reason to claim it is closed.
- It does not constrain database permissions. The connection string in
  `DATABASE_URL` is whatever the deployment supplies; if that role may run `ALTER
  TABLE`, it may run it from the serving process.

So this is a **tooling boundary, not a capability boundary** — weaker than Phase
4's `PaymentProvider` taking no `Prisma.TransactionClient`, where the *type system*
makes the unwanted call unrepresentable. Nothing here is enforced by the compiler
or by the database. Do not describe it as if it were, and do not cite it as
Phase 4's equivalent.

What would make it a real capability boundary is a least-privilege database role
for the application, distinct from the role that runs migrations. **That is
explicitly out of scope for Phase 6** (§2.2 and §19.3, item 8): it is a database
administration decision needing a migration story for existing deployments, and
inventing one here with no real host to apply it to would be exactly the unrun
configuration this phase exists to eliminate.

**The separate-stage design stands on its other reason, which is unaffected:** it
removes the hazard of a migration applied from a *different checkout* than the
running image. The two drift, and nothing detects it. Two `--target` builds from
one Dockerfile and one commit (§9.1) remove that class of error entirely, and that
argument needs no claim about what the serving container is capable of.

### 9.3 Honest costs

The `migrate` image inherits the full build stage: all source, all
devDependencies. It is fat. Acceptable for an image that never serves traffic and
is never published (D10), and G9's `.dockerignore` tightening keeps the SDD ledger
and `docs/` out of it.

The runtime stage continues to copy the generated client via
`node_modules/.prisma`, a layout Prisma does not contract (G5, first half). Phase 6
does **not** fix that — it is a latent upgrade hazard, not a defect, and the fix
(a documented Prisma output path) is a Prisma-version question rather than a
deployment one. §19.3 keeps it recorded as a deferred limitation with its trigger:
a Prisma major upgrade.

### 9.4 Release order

Migrations remain a **discrete release command, never run at application boot** —
unchanged from the foundation spec. Phase 6 only makes the tool shippable.

```
1. docker build --target migrate -t <img>:migrate .
2. docker build --target runtime -t <img>:runtime .
3. docker run --rm -e DATABASE_URL=... <img>:migrate     # applies migrations, exits 0
4. docker run -d  -e DATABASE_URL=... <img>:runtime      # serves
```

Step 3 must exit 0 before step 4 starts. Phase 6 adds **no migration of its own**,
so the first real exercise of this path applies the five existing migrations to a
fresh database.

---

## 10. Docker runtime smoke test

The centre of gravity of the phase. It is what turns "the image builds" into "the
image works", and it closes G1, G2, and the `deferred-limitations.md` runtime-image
entry.

### 10.1 Sequence

1. Build both targets (§9.1).
2. Start Postgres on a user-defined Docker network (§12.2).
3. Run the `migrate` image; **require exit 0**.
4. Run the `runtime` image detached, on the same network, under
   `NODE_ENV=production`.
5. Poll `/health/live` until 200 or a bounded timeout.
6. **Poll Docker's own health status until `healthy`** — the `HEALTHCHECK`
   verification of §10.5, not an inference from step 5.
7. Assert the readiness and routing probes (§10.3).
8. Assert the negative controls (§17.2).
9. `docker stop`; assert exit code 0 within 10s (§13).
10. On any failure — including a health status that never reaches `healthy` —
    dump container logs **and** `docker inspect`'s health output before tearing
    down.

### 10.2 The production-environment consequence nobody should rediscover

The smoke test runs under `NODE_ENV=production`, because that is the configuration
whose guards are being proven. Joi then **forbids `PAYMENT_PROVIDER=fake`**, so the
smoke test is forced onto the Stripe adapter, which requires `PAYMENT_API_KEY`.

Verified inert: `StripePaymentProvider`'s constructor reads the webhook secret and
the API key, **throws if the key is empty or undefined**, and makes **no network
call**. So a syntactically plausible dummy key is sufficient for the container to
boot, and no endpoint the smoke test touches reaches the provider.

Consequences for the test, all mandatory:

- Set `PAYMENT_PROVIDER=stripe` and a dummy `PAYMENT_API_KEY`. The key is not a
  secret and must be obviously fake.
- Set `PAYMENT_WEBHOOK_SECRET` to at least 16 characters (Joi floor).
- **Touch no route that calls the provider.** No payment initiation, no webhook.
- **Do not assert the absence of error-level logs.** Maintenance jobs are enabled by
  default and the reconciliation sweep (`0 */15 * * * *`) or the expiry sweep
  (`0 */5 * * * *`) may tick during the smoke window and fail against the dummy
  key. That is harmless — the scheduler catches, the lease is released by the
  runner's `finally`, the next tick retries — but an "no errors in logs" assertion
  would be flaky for exactly that reason. Assert what is positively expected
  instead.

### 10.3 Positive assertions

| Assertion | What it proves that nothing proves today |
|---|---|
| `GET /health/live` → 200 | The process boots, binds, and serves inside the image |
| `GET /health` → 200, body `status: "ok"` | Prisma connected to a real database from inside the container |
| `GET /api/v1/products` → 200, body shaped `{ data: [], meta: … }` | Global prefix, URI versioning, the `@Public()` path through three global guards, a real query, and DTO mapping — all in the real artifact. Chosen because it is `@Public()` and correct on an **empty** database, so it needs no seeding |
| Three `Scheduled <job> with "<cron>"` lines in logs | `ConfigService` → `SchedulerRegistry` wiring works in the image. Currently proven only by unit tests |
| `migrate` image exits 0 and five migrations are applied | The release path of §9.4 |

`GET /api/v1/products` is deliberately preferred over the `/api/v1/ping` fixture,
which exists only in the e2e test harness and is not present in the image.

### 10.4 The readiness/liveness divergence assertion

The strongest available evidence for §6.2, and worth its cost: stop the Postgres
container, then assert `/health/live` → **200** while `/health` → **503**; restart
Postgres and assert `/health` returns to 200.

This proves three things at once: liveness does not depend on the database,
readiness does, and Prisma reconnects without a restart — which is the entire
argument for the split. It is the highest-flake-risk assertion in the phase
(reconnection is not instantaneous), so it must use bounded polling with a generous
ceiling rather than a fixed sleep, and it must dump logs on failure. If it proves
unstable in practice, it is downgraded to the unit-level equivalent in §17.1 and
the fact is recorded — not quietly deleted.

### 10.5 The `HEALTHCHECK` must be verified at runtime, not by inspection

**A `HEALTHCHECK` instruction present in the Dockerfile is not evidence that the
health check works.** It is evidence that a line was written. The instruction can
be syntactically valid and still never report healthy — the most likely cause
being that the command it invokes does not exist in the final runtime image.

This is a live risk rather than a hypothetical one. The chosen command relies on
`wget`, which this repository has never invoked inside the image: `wget` appears
nowhere in the current `Dockerfile`. It is expected to be present via busybox in
`node:20-alpine`, but **that expectation is unverified in this repository and must
not be assumed** — a base-image change, a `node:20-alpine` variant without it, or
a distroless migration would each break it silently. Silently is the operative
word: a `HEALTHCHECK` whose command is missing reports **unhealthy**, not an
error, so a container that is serving perfectly can be marked unhealthy and
restarted by an orchestrator forever, with no log line naming the cause.

So the smoke test verifies the check itself, mechanically (C-D11):

1. **Wait for Docker's health status to become `healthy`**, read from the
   container's actual state — `docker inspect`'s `.State.Health.Status`. This is
   the assertion that carries the content, because it is Docker executing the
   configured command rather than the test executing an equivalent one.
2. **Bounded polling, never a fixed sleep.** A fixed sleep either flakes when the
   interval is slow or wastes time when it is fast; a `HEALTHCHECK` has a
   start period, an interval, and a retry count, so the ceiling must accommodate
   `start period + interval × retries` with margin. A timeout is a **failure**,
   not a skip.
3. **Confirm the configured command actually runs in the final runtime image** —
   execute it inside the running container and require success. This is what
   separates "the endpoint is reachable" from "the command Docker runs can run at
   all", and it is the specific check that catches a missing `wget`.
4. **Confirm the endpoint is `/health/live`**, not `/health`. §6.5 assigns
   container liveness to `/health/live`, and §6.2 explains why pointing it at the
   database-touching endpoint reintroduces the crash loop. A check configured
   against the wrong endpoint would pass every "is it healthy" assertion while
   carrying exactly the defect the split exists to prevent — so the endpoint is
   asserted explicitly, not inferred from a green status.
5. **On failure, dump both the container logs and `docker inspect`'s health
   output.** The health output carries the failing command's own stdout/stderr and
   exit code, which the application logs never contain — a health check failing
   for a missing binary produces nothing in the application log at all.

Note the division of labour, which is why step 1 does not make step 5 of §10.1
redundant: polling `/health/live` from the test proves the **endpoint** serves;
polling Docker's health status proves the **check** works. Either can pass while
the other fails, so both are asserted.

---

## 11. Compose: app and migration services

**D8: one compose file.** `docker-compose.yml` gains two services and keeps
everything it has.

- **`app`** — builds the `runtime` target, `depends_on: postgres:
  condition: service_healthy` (the healthcheck already exists), and reads its
  configuration from the environment.
- **`migrate`** — builds the `migrate` target, same dependency, a one-shot service
  that exits.

`postgres` keeps its published `5432`, and `postgres-test` keeps `5433` and its
tmpfs. Breaking the development workflow to look more production-like would be a
regression.

**Why not a second, production-shaped compose file.** It would demonstrate network
isolation — Postgres on an internal network with no published port — but nothing
would ever run it. An unrun compose file is exactly the aspirational, unverified
configuration this phase exists to eliminate; it would be a new G1 wearing different
clothes. The network-boundary rule is therefore **documented** (§15.2) and the
isolation that *is* verified is the one CI actually exercises (§12.2).

---

## 12. CI workflow and the database network

### 12.1 Change

Extend the existing `docker` job from *build* to **build → migrate → run → probe →
stop**, executing §10's sequence. It stays a required check on pull requests to
`master`, like the other four jobs. The job's existing comment that publishing
"belongs to Phase 6" is updated to record that Phase 6 **declined** to publish
(D10), so the comment does not read as a still-open promise.

### 12.2 The container→database network, and why it is not a service container

Every other database-using job in `ci.yml` uses a GitHub Actions **service
container**, reachable from the job on `localhost`. That pattern does not work
here: the application under test is itself a `docker run` container on the default
bridge network, and the service container is not reachable from there by
`localhost`.

**Resolution: run Postgres as a plain container on a user-defined Docker network,
and attach the `migrate` and `runtime` containers to the same network.** They then
address Postgres by its container name, and nothing depends on the runner's
`localhost`.

This also delivers the only network isolation the phase actually verifies: on a
user-defined network, Postgres needs **no published port at all**, so the smoke run
genuinely demonstrates an app reaching a database that is not reachable from
outside the network (§15.2).

Two consequences to record:

- This job no longer mirrors the `services:` idiom the other jobs use. That is
  intentional and must be commented in the workflow, or a future maintainer will
  "fix" it back into a service container and break the networking.
- The job must choose a port distinct from the established convention — 5432 dev,
  5433 e2e, 5434 bootstrap — or document that no port is published at all, which is
  the preferred outcome.

### 12.3 Failure diagnosis

Container logs are dumped on any failure, for both the `migrate` and `runtime`
containers. A smoke test that fails without logs is a smoke test nobody can fix,
and this job is the one place in CI where the failure is three layers away from the
assertion.

---

## 13. SIGTERM and shutdown semantics

### 13.1 What exists

`configureApp()` calls `app.enableShutdownHooks()`, so Nest registers signal
handlers and `CMD ["node", "dist/main"]` makes node PID 1, which receives the
signal. The mechanism is almost certainly correct.

**It is entirely unproven.** Zero tests reference `SIGTERM`, `SIGINT`, or shutdown
(G6). "Almost certainly correct and never measured" is the condition this project
does not accept for anything it claims.

### 13.2 What Phase 6 proves

`docker stop` on an idle container → **exit code 0 within 10 seconds** (C-D9).

Exit 0 is the assertion that carries the content. `docker stop` sends SIGTERM, waits
its grace period, then SIGKILLs; a container that ignored SIGTERM would still
"stop", but with exit code 137. So asserting exit 0 within a bound is what
distinguishes a graceful shutdown from a kill, and asserting merely that the
container stopped would pass against a process with no handler at all.

### 13.3 No init process is added

`node` as PID 1 is sufficient here: Nest registers real handlers, and this image
spawns no child processes needing reaping. Adding `tini` or `dumb-init` would be a
new dependency justified by a problem C-D9 is designed to detect. If C-D9 fails,
that is the evidence that reopens the question — not a guess made in advance.

### 13.4 The in-flight limitation, documented not fixed

Two properties are stated and deliberately left untested:

- **In-flight HTTP requests.** `app.close()` stops the server; whether every
  in-flight request completes under load is not asserted. Phase 6 asserts clean
  shutdown of an *idle* container.
- **In-flight maintenance sweeps.** `MaintenanceScheduler.tick()`'s promise is
  floating — `onTick` does not await it through a lifecycle hook — so `app.close()`
  does not wait for a running sweep. A container stopped mid-sweep may be killed
  before the runner's `finally` releases the lease, leaving it held until
  `expiresAt`, up to `MAINTENANCE_LEASE_SECONDS` (default 300s). The next
  instance's tick then reports `skipped: lease-held` until it lapses.

Both go in the runbook and in `deferred-limitations.md`. Testing mid-sweep drain
would require interleaving a shutdown with a sweep at a precise moment — a flake
factory whose failures would look like application bugs. Stating the property
honestly is worth more than an unreliable test, and the behaviour is *safe*: a
lapsed lease is exactly the recovery path Phase 5 designed for a crashed holder.

---

## 14. Maintenance scheduler under this topology

### 14.1 No code change

Phase 6 changes no scheduler code, no job, and no lease logic. This section records
behaviour and limitations under the deployed topology, and adds one smoke
assertion.

### 14.2 At one instance

The lease is redundant but harmless: one holder, no contention. It stays because it
is what makes a second instance safe without a redesign, and because correctness
never depended on exclusivity in the first place — the per-order compare-and-swap
and the in-transaction fence do that work, as Phase 5's recorded C-E2 control
demonstrates.

The smoke test asserts the three `Scheduled <job>` log lines (§10.3), which proves
config → `SchedulerRegistry` wiring **in the real image**. Today that path is
covered only by unit tests, and a deployment where cron silently never registered
would look healthy on every probe.

### 14.3 What changes at more than one instance

Nothing in the maintenance layer — that is the point of Phase 5's design. Each
instance registers its own crons, and the lease ensures one does the work while the
others report `skipped: lease-held`. The things that *do* change are throttling
(§14.4) and lease-holder attribution (G12: the holder is an opaque per-process
UUID, so logs cannot name the container). Neither is fixed here.

### 14.4 Throttling, and why Redis is not justified

**D2: no Redis.** At one instance, in-memory throttler storage is **correct**, not a
compromise, and this is the phase's most load-bearing "we did not add that"
decision.

Redis would introduce a runtime dependency and a new failure mode to solve a
problem that does not exist at this topology. Its own down-behaviour is an
unanswerable fork:

- **fail-open** — the storage is unreachable, rate limiting silently disappears,
  and nothing says so. The control is gone at exactly the moment infrastructure is
  degraded and an attacker is most likely to be probing.
- **fail-closed** — a cache outage becomes a total API outage.

Neither is right in general, which is Phase 5's no-universal-fail-closed finding a
third time (after the lease direction and the Stripe status mapping). Choosing
between them requires knowing which risk the deployment prefers — the same thing
`TRUST_PROXY_HOPS` requires the deployer to state.

**What ships instead** is a sharpened deferred entry, replacing the vague "Redis
when multi-instance" with a number and a named decision:

- With `N` replicas and in-memory storage, the effective limit is **`N × limit` per
  client**, and buckets do not share. The login control degrades from 5/minute to
  **5N/minute** — weakened, not eliminated.
- The trigger is a second replica, not a date.
- Whoever adds Redis must also decide fail-open vs fail-closed **explicitly**, and
  record it.

A number and a named decision beat "later". `deferred-limitations.md` gets this
text (§19.3).

---

## 15. Security and network boundaries

### 15.1 Unchanged and still correct

Non-root `USER app`; no secrets baked into any image; `.env` excluded by
`.dockerignore`; `helmet()` and config-driven CORS in `configureApp()`;
`PAYMENT_PROVIDER=fake` rejected under production at boot. Phase 6 preserves all of
it and adds no exception.

### 15.2 Added by this phase

| Change | Effect |
|---|---|
| `TRUST_PROXY_HOPS` required under production (§5) | Closes the documented rate-limiting gap — the phase's one real security fix |
| Swagger not served under production (§8) | The admin surface, including the maintenance trigger, is no longer published by a production container |
| `CORS_ORIGIN='*'` forbidden under production (§7.3) | Narrows G7's residue; explicitly the weakest of the three |
| No `prisma` CLI in the runtime image (§9.2) | The standard Prisma migration CLI is absent from the serving image, asserted by C-D10 rather than stated. A **tooling boundary, not a capability boundary**: it does not prove schema mutation is impossible, because `$executeRaw`/`$executeRawUnsafe` remain available and the database role is whatever `DATABASE_URL` supplies (§9.2) |
| `.dockerignore` gains `docs/`, `test/`, `.superpowers/`, `.claude/` | The **gitignored** SDD ledger stops landing in the build layer (G9) |
| Postgres unpublished on the CI smoke network (§12.2) | The one network boundary this phase actually verifies rather than documents |

### 15.3 The documented boundary

The runbook states the rule the phase cannot test without a host: **the database
must not be reachable from the internet.** Development compose keeps `5432`
published for convenience and that is correct for development (§11). The CI smoke
network demonstrates the isolated shape.

### 15.4 Secrets

No secret enters an image, a compose file, or a workflow file as a real value.
CI-only values stay obviously fake and are named so, following the existing
`ci-only-secret-not-used-outside-continuous-integration` convention. The §7.4 boot
log is explicitly in scope for every existing "never log" rule.

---

## 16. Observability

**D9: `TZ=UTC` (§7.3) and the boot topology log (§7.4). Nothing else.**

Structured JSON logging, request/correlation ids, metrics, and tracing are
deferred. Two reasons, both specific:

1. A logging subsystem is not deployment work. It changes every log site in the
   application and deserves its own phase with its own review.
2. `main.ts` cannot read `process.env` to pick a log level without breaking the
   rule that `src/config/` is the only reader of `process.env` — and Nest's logger
   option is a `NestFactory.create` argument, evaluated before `ConfigService`
   exists. That is the same ordering constraint Phase 5 hit with `@Cron()`, and
   solving it properly is a design question, not a line of deployment config.

**Trigger for taking it up:** a log aggregator exists, or more than one instance
runs. Until then, the boot topology line answers the operational question that
actually comes up — "what does this container think it is" — for about five lines
of code.

Failure recovery needs no new machinery: every maintenance job is a sweep that
re-reads the world each tick and is therefore self-healing. The one addition is
runbook text stating that a crash mid-sweep stalls that job for at most
`MAINTENANCE_LEASE_SECONDS` (§13.4).

---

## 17. Testing strategy and negative controls

### 17.1 Standing discipline

A green run is never evidence. **Every control below must be mutation-verified:
break the thing it defends and confirm the test fails on the assertion that
*names* the property, not incidentally.** Phase 5 recorded seven cases where a
guard protected the wrong half and the test only appeared to defend it; the fix
each time was mutation, not more tests.

Four controls in this phase are especially prone to passing for the wrong reason,
and their mutations are specified rather than left to judgement:

- **C-D1** passes trivially if the test sends a single-entry `X-Forwarded-For`
  (§17.3).
- **C-D9** passes against a process with no SIGTERM handler at all if it asserts
  only that the container stopped (§13.2).
- **C-D3** passes trivially if `/health/live` is asserted only while the database
  is **up** — every endpoint returns 200 then, so the assertion distinguishes
  nothing. The control exists only in the database-down state.
- **C-D11** passes trivially if it asserts that the Dockerfile *contains* a
  `HEALTHCHECK` line, or if it re-implements the check in the test rather than
  reading Docker's own health state. Both would pass against a check whose command
  is absent from the image and against one pointed at the wrong endpoint
  (§10.5).

### 17.2 Layers

| Layer | Adds |
|---|---|
| **Unit** | `/health/live` returns 200 while a mocked `PrismaService.$queryRaw` **rejects**, and `/health` throws 503 against the same mock — the deterministic form of §10.4. Joi: hops required under production, hops defaults to 0 outside it, `CORS_ORIGIN='*'` rejected under production, `CORS_ORIGIN` required under production (§7.2) |
| **E2E** | `/health/live` → 200, unprefixed and unversioned like `/health`; `/health/live` survives past the throttle limit while `/health` does not; the two trust-proxy controls (§17.3) |
| **Container** | §10.3's positive assertions, §10.4's divergence assertion, §10.5's `HEALTHCHECK` verification, and C-D5…C-D11 |

E2E coverage of the proxy controls is possible only because
`test/helpers/create-test-app.ts` calls the real `configureApp()` (§5.4). The hop
count must be injectable per suite; the value `1` lives in the test and carries no
authority over any deployment (§5.2).

### 17.3 The control table

| ID | Control | Names the property | Mutation that must fail it |
|---|---|---|---|
| **C-D1** | With `hops=1` and `X-Forwarded-For: <rotating forged>, 10.0.0.5`, six requests to a 5/minute route: the sixth must still **429** | Hop counting from the **right**: a forged prefix cannot mint a bucket | `trust proxy: true` → each rotation is a fresh bucket and all six pass. **A single-entry XFF makes this control vacuous** — the forged value *is* the client there |
| **C-D2** | Two requests whose **last** XFF entry differs get independent buckets | We did not collapse everyone into one bucket and call it safe | `trust proxy` unset → both key on the socket address, one shared bucket |
| **C-D3** | Postgres stopped: `/health/live` → 200, `/health` → 503 (container), and the mocked equivalent (unit) | Liveness is independent of the database | `/health/live` querying the database → it 503s too |
| **C-D4** | `/health/live` still 200 past the global throttle limit | Probes are not rate-limited | removing `@SkipThrottle()` → 429 |
| **C-D5** | Image boots with `PAYMENT_PROVIDER=fake` + `NODE_ENV=production` → **non-zero exit**, named message | The production provider guard works in the **shipped artifact** | removing the `Joi.override` → boots happily. *Unit tests prove the schema; only this proves the image* |
| **C-D6** | Image boots under production with `TRUST_PROXY_HOPS` unset → **non-zero exit** | The hop count has no default under production | adding a default → boots with silent `0` |
| **C-D7** | Image boots under production with `CORS_ORIGIN='*'` → **non-zero exit** | The wildcard guard | dropping `.invalid('*')` → boots |
| **C-D8** | `GET /api/docs` under production → not served | The admin surface is not published | removing the gate → 200 |
| **C-D9** | `docker stop` → **exit 0 within 10s** | SIGTERM is **handled**, not survived | removing `enableShutdownHooks()` → SIGKILL, exit 137. *Asserting only "it stopped" passes against no handler at all* |
| **C-D10** | The standard Prisma migration CLI is **absent** from the runtime image — `prisma` does not resolve as an executable there | The serving image carries **no migration tooling**. Scope is exactly that: **not** that schema mutation is impossible (§9.2) | promoting `prisma` to a production dependency → the CLI resolves and the tooling boundary is gone |
| **C-D11** | Docker's own health status reaches **`healthy`** within a bounded poll; the configured command **runs successfully inside the final runtime image**; and the configured endpoint is **`/health/live`** (§10.5) | The `HEALTHCHECK` *works*, as distinct from existing. Covers both halves: Docker can execute the command, and it targets the endpoint §6.5 assigns | point the check at a command absent from the image (e.g. `curl`) → status stays `unhealthy` and the in-container execution fails. Point it at `/health` → the endpoint assertion fails **while the status assertion still passes**, which is exactly why the endpoint is asserted separately. *Asserting only that the Dockerfile contains a `HEALTHCHECK` line passes against every one of these mutations* |

C-D5 through C-D7 share a shape worth naming: each proves that a guard already
unit-tested **also holds in the artifact that ships**. That gap — schema proven,
image unproven — is the whole reason §10 exists.

### 17.4 No regression

All existing gates stay green with the new tests included: `lint:ci`, `build`,
**33 unit suites / 430 tests**, **28 e2e suites / 337 tests**, OpenAPI inventory
**21/21**. A `TRUST_PROXY_HOPS` default of `0` outside production keeps every
existing e2e suite byte-identical in behaviour; the full suite passing unchanged is
the evidence for that, not an argument.

`maxWorkers: 1` stays (`test/jest-e2e.json`). Phase 6 adds no per-worker isolation
and the standing constraint is unchanged.

---

## 18. Task boundaries and dependencies

Seven tasks, the same shape as Phase 5. T6 is the phase's centre of gravity.

| # | Task | Depends on | Touches | Closes |
|---|---|---|---|---|
| **T1** | `/health/live` + probe semantics | — | `health.controller.ts`, its spec, `app.e2e-spec.ts`/`routing.e2e-spec.ts` | G4 |
| **T2** | Trusted proxy: `TRUST_PROXY_HOPS`, Joi, `configureApp()`, `.env.example`, C-D1/C-D2 | — | `env.validation.ts`, `configuration.ts`, `bootstrap.ts`, `.env.example`, e2e | **G3**, deferred entry #1 |
| **T3** | Production guards: Swagger gate, CORS wildcard, `TZ`, boot topology log | **T2** (shares `env.validation.ts`, `configuration.ts`, `.env.example`) | `main.ts`, `env.validation.ts`, `configuration.ts`, `Dockerfile` | G7, G8, G11 |
| **T4** | Dockerfile: `migrate` stage, `HEALTHCHECK`, `.dockerignore` | — | `Dockerfile`, `.dockerignore` | G5 (second half), G9 |
| **T5** | Compose `app` + `migrate` services | **T4** | `docker-compose.yml` | local reproducibility |
| **T6** | **CI smoke job**: build → migrate → run → health-verify → probe → stop, with C-D5…C-D11 | **T1, T2, T3, T4** | `.github/workflows/ci.yml` | **G1, G2, G6**, deferred entry #2 |
| **T7** | Docs: release runbook, `deferred-limitations.md`, `CLAUDE.md`, README | **T1–T6** | `README.md`, `docs/deferred-limitations.md`, `CLAUDE.md` | `README.md:32` |

### 18.1 Ordering notes

- **T2 before T3** is a file-contention constraint, not a logical one: both edit
  `env.validation.ts`, `configuration.ts`, and `.env.example`. Running them
  concurrently guarantees a conflict in the one file where a merge error is a
  security bug.
- **T1, T2, T4 are mutually independent** and may proceed in any order.
- **T6 depends on all of T1–T4** because it asserts their behaviour in the
  container. Attempting it earlier produces a job asserting things that do not yet
  exist.
- **T7 last**, because it records measured numbers. Writing it earlier means
  writing numbers that are not yet true — the failure mode this project treats most
  seriously.

### 18.2 Per-task gates

Each task independently: `npm run lint:ci`, `npm run build`, `npm test`, and
`npm run test:e2e` when it touches anything database- or app-wiring-dependent
(T1, T2, T3 all do). Each task gets an independent review before the next starts.
Every control in §17.3 introduced by a task must be mutation-verified **within that
task**, and the mutation recorded.

---

## 19. Risks, rollback, and deferred limitations

### 19.1 Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **Container→database networking in CI.** A `docker run` container cannot reach a GitHub Actions *service container* on `localhost`. Highest-probability source of iteration in the phase | §12.2's user-defined network. Expect one or two CI iterations; this is a known cost, not a blocker |
| **R2** | **Smoke-test flake.** §10.4's stop/restart assertion depends on Prisma reconnecting within a window | Bounded polling with a generous ceiling, never a fixed sleep. Assert body content, not just status. Dump logs on failure. If genuinely unstable, downgrade to §17.2's unit equivalent and **record the downgrade** |
| **R3** | **`configureApp()` is the seam all 28 e2e suites share.** A mistake there breaks everything at once | `TRUST_PROXY_HOPS` defaults to `0` outside production, making behaviour byte-identical. The full e2e suite passing unchanged is the evidence |
| **R4** | **`TRUST_PROXY_HOPS` required under production is a breaking change** for any existing production boot | Correct and intended. C-D6 makes it **loud** at boot rather than silent at runtime, which is the entire design (§5.3) |
| **R5** | **Scope creep.** A deployment phase invites Redis, Kubernetes, a registry, a log pipeline | §2.2 names every exclusion with a reason. D1–D10 are locked; changing one requires amending §3 with repository evidence |
| **R6** | Build time grows (a second image per CI run) | Accepted. Both stages share the `build` layer, so the marginal cost is the `migrate` tag and the smoke run |

### 19.2 Rollback

**Phase 6 ships zero migrations.** Consequently `git revert` has **no database
consequence** — not true of any prior phase in this project.

Every change is additive except two one-line edits: the `trust proxy` call in
`configureApp()` and the Swagger gate in `main.ts`. Both revert cleanly. The new
Docker `migrate` stage, the compose services, and the CI job are all additions that
can be removed without touching application code.

The one non-revertible consequence is operational, not technical: once
`TRUST_PROXY_HOPS` is required under production, a deployment that has not set it
will not boot. Reverting the guard restores the previous (silently unsafe)
behaviour.

### 19.3 `deferred-limitations.md` changes

**Closed by shipping** (never by deleting the entry):

1. *"Rate limiting keys on `req.ip`, with no trusted-proxy configuration"* —
   `Owner: Phase 6`. Closed by §5. The closing note must state the policy (a
   required per-deployment hop count), that **one hop is the reference topology and
   not a universal value** (§5.2), and that **too high is the dangerous direction**.
2. *"The runtime image's Prisma setup is undeclared and untested"* —
   `Owner: Phase 6`. Closed **in part**, and the entry must say which part. Closed:
   CI now runs the image, and the migration path ships as an artifact. **Still
   open:** the runtime stage still copies the generated client via the
   non-contract `node_modules/.prisma` layout. The remainder keeps its own entry
   with the trigger *a Prisma major upgrade*.

**Sharpened, not closed:**

3. The throttler-storage entry gains §14.4's content: the `N × limit` number, the
   `5N/minute` login degradation, a second replica as the trigger, and the explicit
   requirement that whoever adds Redis decides fail-open vs fail-closed and records
   it.

**Newly added:**

4. **Shutdown drains neither in-flight requests nor in-flight sweeps** (§13.4),
   with the lease-held consequence and its bound.
5. **Liveness and readiness have different semantics** and the probe assignment in
   §6.5 must be honoured — pointing a liveness probe at `/health` reintroduces the
   crash loop §6.2 describes.
6. **The scheduler registers crons in `onModuleInit`, before `app.listen()`**, so a
   tick can fire while the port is still binding.
7. **No request logging exists**, so `TRUST_PROXY_HOPS` is verifiable only through
   throttling behaviour (§5.5). A misconfigured hop count has no direct log signal.
8. **The serving image's lack of migration tooling is a tooling boundary, not a
   capability boundary.** C-D10 proves the standard Prisma migration CLI is absent.
   It does **not** prove schema mutation is impossible: `$executeRaw` and
   `$executeRawUnsafe` remain on the client (unused for DDL today — the only raw
   SQL in `src/` is the health check's `SELECT 1`), and the database role is
   whatever `DATABASE_URL` supplies. Closing it needs a least-privilege application
   role distinct from the migration role, which is a database administration
   decision with a migration story for existing deployments. **Trigger:** a real
   deployment exists whose database credentials this project controls.

---

## 20. Acceptance criteria / Definition of Done

Each item is a pass/fail check, not a judgement.

**Verified behaviour**

1. `GET /health/live` → 200 `{ status: 'ok' }`, unprefixed and unversioned.
2. `GET /health` unchanged: 200 `{ status, timestamp }`, 503 when the database is
   unreachable, still throttled.
3. `GET /health/live` still 200 past the global throttle limit (C-D4).
4. In the container: `/health/live` 200, `/health` 200 with `status: "ok"`,
   `GET /api/v1/products` 200 shaped `{ data: [], meta }` (§10.3).
5. In the container: the three `Scheduled <job> with "<cron>"` lines appear.
6. The `migrate` image applies all five existing migrations to a fresh database and
   exits 0.
7. `docker stop` → exit **0** within 10s (C-D9).
8. Postgres stopped → `/health/live` 200 while `/health` 503; restored → `/health`
   200 again (C-D3/§10.4) — **or** the documented downgrade to §17.2's unit
   equivalent, with the downgrade recorded.

**Negative controls, each mutation-verified**

9. C-D1 and C-D2 (trust proxy), with C-D1's single-entry-XFF vacuity explicitly
   checked.
10. C-D5, C-D6, C-D7 — three boot aborts in the **image**, each non-zero with its
    named message.
11. C-D8 — `/api/docs` not served under production.
12. C-D10 — the standard Prisma migration CLI is absent from the runtime image.
    The claim recorded is the **tooling boundary only**; no document produced by
    this phase may state that schema mutation from a serving container is
    impossible (§9.2).
13. C-D11 — the `HEALTHCHECK` verified at runtime per §10.5: Docker's health status
    observed reaching `healthy` under **bounded polling** (a timeout is a failure,
    not a skip), the configured command **executed successfully inside the final
    runtime image** (so a missing `wget` is caught), and the endpoint asserted to
    be **`/health/live`**. Logs and `docker inspect` health output dumped on
    failure.
14. Every control's mutation recorded: what was broken, which assertion failed, and
    that it was the assertion **naming** the property.

**Configuration and artifact**

15. `TRUST_PROXY_HOPS` present in `env.validation.ts`, `configuration.ts`,
    `.env.example`, and the README — required under production, defaulting to `0`
    elsewhere. The hop-count rule of §5.2 holds, and its scope is exactly these
    four checks — **not** a repository-wide prohibition on the number `1`:
    - **15a.** No production default or fallback of `1`. The only default anywhere
      is `0`, and it applies outside production only; under production there is no
      default at all (§5.3).
    - **15b.** `.env.example` carries `TRUST_PROXY_HOPS=0`, with the comment
      explaining that the correct value is the number of proxies that will append
      to `X-Forwarded-For`.
    - **15c.** The README does not present `1` as a universal or recommended
      deployment value. Where it appears, it is labelled as the reference topology
      used by the tests, alongside `0` for direct-to-Node and `2` for a two-proxy
      chain.
    - **15d.** Tests **may** set `1` explicitly, and are expected to: the one-hop
      reference topology is what C-D1 and C-D2 assert against. The value is
      injected by the test, local to it, and carries no authority over any
      deployment. A test setting `1` is correct and must not be flagged as a
      violation of this item.
16. `CORS_ORIGIN` required and `'*'`-forbidden under production.
17. `ENV TZ=UTC` in the Dockerfile, and a `HEALTHCHECK` targeting `/health/live`
    whose correctness is established by C-D11 at runtime — **the presence of the
    instruction is not sufficient evidence** (§10.5). Specifically: Docker's own
    health status observed reaching `healthy` under bounded polling, the
    configured command executed successfully inside the final runtime image, and
    the endpoint asserted to be `/health/live`. On failure, container logs **and**
    `docker inspect` health output dumped.
18. `.dockerignore` excludes `docs/`, `test/`, `.superpowers/`, `.claude/`.
19. The boot topology log present and **leaking no secret**.
20. Compose `app` and `migrate` services present; `postgres` keeps `5432` and
    `postgres-test` keeps `5433`/tmpfs.
21. The CI `docker` job runs the image and is required on pull requests, with
    §12.2's network choice commented so it is not "fixed" back.

**Discipline**

22. **Zero migrations.** `prisma/migrations/` is unchanged.
23. **Zero new runtime dependencies.** `package.json` `dependencies` unchanged.
24. No new route beyond `/health/live`. No change to `markPaid()`'s sole-writer
    status, to any sweep, or to any lease logic.
25. `lint:ci` clean, `build` clean, unit **≥ 33 suites / 430**, e2e **≥ 28 suites /
    337**, OpenAPI **21/21** — all green, new tests included.
26. `deferred-limitations.md`: entries 1 and 2 of §19.3 closed by shipping with
    their stated caveats, entry 3 sharpened, entries 4–8 added. **No entry deleted.**
27. `README.md:32` checked off, with a release runbook covering §9.4's order,
    §6.5's probe assignment, §5.2's hop-count rule, and §13.4's shutdown caveats.
28. `CLAUDE.md` gains a Phase 6 section recording the non-obvious rules: the hop
    count is per-deployment and too-high is the dangerous direction; liveness must
    never touch the database; `/health` stays throttled and `/health/live` does
    not; the serving image deliberately cannot migrate.
29. Every per-task gate in §18.2 run and reported, with honest numbers.

**Honesty**

30. Any null, qualified, or downgraded result recorded as such — never upgraded.
    §10.4 is the likeliest candidate.
31. No locked decision (D1–D10) changed without §3 amended and the repository
    evidence stated.
