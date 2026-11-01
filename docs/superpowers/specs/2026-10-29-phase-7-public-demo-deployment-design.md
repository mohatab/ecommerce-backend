# Phase 7 — Free-tier public portfolio deployment — design

**Status:** proposed 2026-10-29. Base: `master` at `a84aca7`.
**Provider documentation accessed:** 2026-10-29 (citations in §12).

Deploy the existing tree, unchanged in behaviour, as a public HTTPS API that a
recruiter can inspect and exercise. **Zero application code changes, zero new
dependencies, zero new migrations, zero new environment variables.** Phase 7 is
a configuration-and-evidence phase: everything it needs already exists in
`src/config/env.validation.ts` and the `Dockerfile`.

---

## 1. Correction to the brainstorming output

The brainstorming step listed, as an acceptance criterion, that
`GET https://<app>/api/docs` **serves Swagger**. **That is wrong and is
rejected here.** `src/main.ts:16` computes `swaggerEnabled = env !== 'production'`
and `src/main.ts:33-41` calls `SwaggerModule.setup('api/docs', …)` only inside
that branch. The
comment above it gives the reason, which is a security argument and not a
preference: `SwaggerModule.setup()` installs **Express middleware**, so it sits
outside the Nest guard chain — neither `JwtAuthGuard` nor `RolesGuard` applies
to it — and an ungated production container therefore publishes the complete
admin surface including `POST /api/v1/admin/maintenance/:job/run`.

**The production-disabled design stays intact.** `/api/docs` returning **404**
in production is a PASS, not a defect, and §8 asserts it as such. §7 defines how
the 26-operation inventory is verified without it.

## 2. Architecture

```
curl / browser / Stripe (test mode)
          │  HTTPS — Render-managed TLS, HTTP→HTTPS redirect
          ▼
┌──────────────────────────────────────────────┐
│ Render Web Service — Free, region Frankfurt  │
│   Language: Docker, built from this repo     │
│   last Dockerfile stage = runtime            │
│   PORT=3000 · health check path /health/live │
│   spins down after 15 min idle (~1 min wake) │
│   ephemeral filesystem, no disk              │
└───────────────────┬──────────────────────────┘
                    │ Postgres over TLS (sslmode=require)
                    │ runtime → POOLED endpoint
                    ▼
┌──────────────────────────────────────────────┐
│ Neon — Free plan, AWS eu-central-1           │
│   1 GB storage · 0.25 CU · 100 CU-h/month    │
│   scale-to-zero after 5 min (not disableable)│
└──────────────────────────────────────────────┘
                    ▲
                    │ DIRECT (non-pooler) endpoint, one-shot
          ┌─────────┴──────────┐
          │ operator's machine │  docker build --target migrate
          └────────────────────┘  → prisma migrate deploy
```

**Why the compute and the database are different vendors.** Render's own free
Postgres **expires 30 days after creation** and is deleted after a 14-day grace
period. A portfolio demo must outlive a month, so Render's free database is
disqualified on its own documented terms. Neon's free plan suspends compute at
its limits but states that none of those limits delete data.

**Both regions are Frankfurt** (Render `frankfurt`, Neon `aws-eu-central-1`) for
latency. The link is the public internet regardless — Neon is not on Render's
private network — so co-location buys round-trip time, not isolation.
**Region is fixed after creation** on Render and must be chosen correctly the
first time.

**No container registry.** Render builds the Dockerfile from the repo with
BuildKit and stores the result in its own private registry. Phase 6's D10
refusal to publish images is **unchanged**; §11 records the trigger that would
revisit it.

## 3. Repository facts this design rests on

Each was read from the tree at `a84aca7`, not assumed.

| Fact | Where | Consequence for Phase 7 |
|---|---|---|
| `runtime` is the **last** Dockerfile stage | `Dockerfile:35` | Render, which does not document target selection, builds the server by default. No `--target` needed |
| `HEALTHCHECK` hardcodes `http://127.0.0.1:3000/health/live` | `Dockerfile:102-103` | `PORT=3000` is **mandatory**; Render's default `PORT` is `10000`, which would leave the container's own check probing a dead port |
| `port: parseInt(process.env.PORT ?? '3000', 10)` | `src/config/configuration.ts:73` | `PORT=3000` is honoured; `app.listen(port)` at `src/main.ts:45` |
| `/health/live` is **synchronous**, does no I/O, `@SkipThrottle()` | `src/modules/health/health.controller.ts:53-58` | Fits Render's 5-second health-check budget even against a suspended Neon compute |
| `/health` does `SELECT 1`, 503 on failure, **stays throttled** | same file, `:61-80` | Database readiness is verified here, **separately**, never as the host probe |
| `health` is `VERSION_NEUTRAL` and prefix-excluded | same file, `:24` | Public paths are `/health` and `/health/live`, **not** `/api/health/*` |
| `PrismaService.onModuleInit()` exits the process on `$connect()` failure | per `Dockerfile:91-95` comment | A failed cold Neon wake at boot is a restart loop. **Locked decision 5: observe, do not pre-emptively add retries** |
| `migrate` stage is `FROM build`, `CMD ["npx","prisma","migrate","deploy"]` | `Dockerfile:31-32` | The release command ships as an artifact; needs only `DATABASE_URL` |
| `datasource db { url = env("DATABASE_URL") }` | `prisma/schema.prisma:5-8` | The migrate container takes **one** variable — no Joi, no app boot |
| The Phase 5 migration `INSERT`s `maintenance_leases` rows | `prisma/migrations/20261007081610_…/migration.sql:59` | `migrate deploy` seeds the leases; the admin trigger is usable immediately |
| `bootstrap-admin.ts` boots the whole `AppModule` | `src/scripts/bootstrap-admin.ts:60-66` | It needs the **complete** production environment, not just `DATABASE_URL` + credentials |
| `ensureAdmin()` never rewrites an existing hash | CLAUDE.md, Phase 2 | Re-running the bootstrap is safe and idempotent |
| `Product.currency` defaults to `"USD"` | `prisma/schema.prisma:64` | Omitting `currency` yields a payable currency |
| Payable range `USD → { 50, 99_999_999 }` | `src/modules/payments/provider/payment-provider.ts:114` | Demo product price must put the order total ≥ 50 minor units |
| Swagger gated on `env !== 'production'` | `src/main.ts:16`, `:33-41` | §1; `/api/docs` must be 404 |
| 26 operations pinned by exhaustive `toEqual` | `test/swagger.e2e-spec.ts:63-90` | §7 |
| Zero file writes anywhere in `src/` | verified: no `multer`, `FileInterceptor`, `diskStorage`, `fs.write` | Render's ephemeral filesystem is a **non-issue**, not a mitigated risk |

**Phase 5's lease design is load-bearing here, and was not chosen for this
reason.** Neon's pooled connections run PgBouncer in transaction mode, which
does **not support session-level advisory locks**. Phase 5 rejected
`pg_advisory_lock` for the maintenance lease in favour of a `MaintenanceLease`
row because `PrismaService` has no connection-pinning API. Had it gone the
other way, the pooled runtime string would have silently broken mutual
exclusion in this deployment. Recorded as a decision that happens to pay off,
not as foresight.

## 4. Environment variables

Every variable below already exists in `src/config/env.validation.ts`.
**Phase 7 adds none.**

### Secrets — entered only in Render's dashboard, never in git, never in chat

| Variable | Joi rule | Purpose |
|---|---|---|
| `DATABASE_URL` | `uri().required()` | Neon **pooled** endpoint + `?sslmode=require` |
| `JWT_SECRET` | `min(32).required()` | HS256 access-token key. Generated locally (§5 step 4) |
| `PAYMENT_API_KEY` | required when `PAYMENT_PROVIDER=stripe` | Stripe **test** secret key (`sk_test_…`) |
| `PAYMENT_WEBHOOK_SECRET` | `min(16).required()` **always** | The real `whsec_…` from the registered endpoint |
| `ADMIN_EMAIL` | `email({tlds:{allow:false}}).optional()` | Bootstrap only |
| `ADMIN_PASSWORD` | `min(8).max(128).optional()` | Bootstrap only; removed from the environment afterwards |

### Non-secret

| Variable | Value | Why this value |
|---|---|---|
| `NODE_ENV` | `production` | Already `ENV` in the runtime stage; gates Swagger, `CORS_ORIGIN`, `TRUST_PROXY_HOPS`, `PAYMENT_PROVIDER` |
| `PORT` | `3000` | Locked decision 1 — matches `EXPOSE` and `HEALTHCHECK` |
| `CORS_ORIGIN` | one explicit origin | `invalid('*').required()` under production |
| `TRUST_PROXY_HOPS` | `1` **as a candidate**, then measured | `required()` under production, no safe default. §6 |
| `PAYMENT_PROVIDER` | `stripe` | `fake` is rejected at boot under production via `Joi.override` |
| `MAINTENANCE_JOBS_ENABLED` | `false` | Locked decision 4. §9 |

Everything else — `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`,
`PAYMENT_PROVIDER_TIMEOUT_MS`, the cron expressions, batch sizes and retention
floors — keeps its Joi default. Setting them would be a knob with no consumer.

**`CORS_ORIGIN` has no browser client in this phase.** There is no frontend, so
the value is a placeholder-but-deliberate single origin. It is not `*` because
Joi forbids that under production, and the reason recorded in
`env.validation.ts` applies: a wildcard lets any origin script the admin
surface with a token obtained elsewhere.

## 5. Deployment sequence

Ordering is the substance. Steps marked **[MANUAL]** require the user's own
account access and cannot be performed by Claude.

| # | Step | Who |
|---|---|---|
| 1 | Create a Neon account; create project in **AWS eu-central-1** | **[MANUAL]** |
| 2 | Copy **both** connection strings: direct and `-pooler`, each with `sslmode=require` | **[MANUAL]** |
| 3 | Create a Render account; connect it to the GitHub repository | **[MANUAL]** |
| 4 | Generate `JWT_SECRET` locally — `openssl rand -base64 48` — and keep it out of chat | **[MANUAL]** |
| 5 | Create a Stripe **sandbox**; copy the `sk_test_…` key | **[MANUAL]** |
| 6 | **Apply migrations** with the shipped migrate target, using the **direct** string | operator, scripted |
| 7 | **Bootstrap the ADMIN** with the shipped runtime image | operator, scripted |
| 8 | Create the Render Web Service: Docker, region Frankfurt, Free, health check path `/health/live`; set every §4 variable except the real `PAYMENT_WEBHOOK_SECRET` | **[MANUAL]** |
| 9 | First deploy; confirm boot log line and `/health/live` | operator |
| 10 | Register the Stripe webhook endpoint at the public HTTPS URL; reveal `whsec_…` | **[MANUAL]** |
| 11 | Set the real `PAYMENT_WEBHOOK_SECRET` in Render; redeploy | **[MANUAL]** |
| 12 | Run the verification suite (§8) | operator |
| 13 | Measure `TRUST_PROXY_HOPS` (§6); correct the value if the measurement says so | operator |
| 14 | Remove `ADMIN_PASSWORD` from Render's environment | **[MANUAL]** |

### Step 6 — migrations, in detail

Migrations are applied **before the application is ever deployed**, from the
operator's machine, using the Dockerfile stage that exists for exactly this:

```bash
docker build --target migrate -t ecommerce-migrate:phase7 .
docker run --rm -e DATABASE_URL="<neon DIRECT url with sslmode=require>" \
  ecommerce-migrate:phase7
```

Exit 0 is the gate. Five migrations apply, and the fifth seeds
`maintenance_leases`.

**The direct endpoint, not the pooled one**, because schema work wants a real
session rather than a transaction pooler. The runtime uses the pooled endpoint.

**Render's pre-deploy command is a paid-plan feature**, so there is no
host-side release phase on Free. That is not a gap being worked around: it is
the same ordering `docker-compose.yml:51-65` already documents — *"A one-shot
release command, not a service … require exit 0 before starting `app`.
Migrations never run at application boot."*

**A redeploy cannot run migrations too late, because it never runs them at
all.** Phase 6 deliberately pruned `prisma` and `@prisma/engines` from the
serving image, so the runtime container is structurally incapable of migrating.
Every future schema change is therefore ordered by construction: migrate, then
deploy. The brief's concern is answered by an existing property, not by new
tooling.

### Step 7 — ADMIN bootstrap, in detail

```bash
docker build --target runtime -t ecommerce-app:phase7 .
docker run --rm \
  -e NODE_ENV=production \
  -e DATABASE_URL="<neon DIRECT url>" \
  -e JWT_SECRET="<generated>" \
  -e CORS_ORIGIN="https://example.invalid" \
  -e TRUST_PROXY_HOPS=1 \
  -e PAYMENT_PROVIDER=stripe \
  -e PAYMENT_API_KEY="sk_test_…" \
  -e PAYMENT_WEBHOOK_SECRET="<any ≥16 chars, placeholder at this stage>" \
  -e MAINTENANCE_JOBS_ENABLED=false \
  -e ADMIN_EMAIL="<admin email>" \
  -e ADMIN_PASSWORD="<strong unique password>" \
  ecommerce-app:phase7 node dist/scripts/bootstrap-admin.js
```

Reusing the **serving** image is the point: the bootstrap runs from the same
bytes that will serve traffic, with no local `node_modules` and no `ts-node`.

The full environment is required because the script boots `AppModule`, so Joi
validates everything. The placeholder `PAYMENT_WEBHOOK_SECRET` here is
**purely to satisfy `min(16).required()` for a script that never receives a
webhook** — and to be explicit, since the brief rightly warns about this:
**a placeholder secret makes nothing about payments functional.** The real
`whsec_` arrives at step 11, and only a genuinely signature-verified event can
move an order to `PAID`. Phase 4's invariant is untouched: `markPaid()` is the
only writer of `OrderStatus.PAID` and `PaymentWebhookService` is its only
caller.

Expected log: `Admin bootstrap complete: created`, plus the warning to change
the password and drop `ADMIN_PASSWORD`. Re-running yields `unchanged` and
never rewrites the hash.

## 6. `TRUST_PROXY_HOPS` — measured, never assumed

**There is no official Render documentation on `X-Forwarded-For` handling.**
Community reports claim Render's proxy appends without stripping client-supplied
entries (which would make `1` correct); another claims the second-to-last entry
was needed. Unresolved from official sources, so `1` enters as a **candidate**,
and Phase 7's deliverable is the measurement, not the guess.

`env.validation.ts` already states the asymmetry: too low degrades availability
loudly, **too high removes the control silently**, and too high is the dangerous
direction. Phase 6's deferred entry already records that throttling behaviour is
the only observable — there is no request logging.

Both probes run against `POST /api/v1/auth/login` (5 req/min) with deliberately
**wrong** credentials, so nothing authenticates and no token is minted.

**Probe A — detects too HIGH (the silent failure).** Send 10 requests, each with
a *different* spoofed `X-Forwarded-For` value.
- If responses settle into 429 → each spoofed value is **not** its own bucket →
  `req.ip` is not attacker-controlled at this hop count. **PASS.**
- If all 10 return 401 and none 429 → each spoofed value *is* its own bucket →
  `req.ip` resolves to client-supplied data → **the limit is bypassable.
  Decrement and re-measure.**

**Probe B — detects too LOW (the loud failure).** From two genuinely different
source addresses (e.g. home network and a cellular connection), exhaust client
A's budget, then send one request as client B.
- B is not 429'd → distinct buckets. **PASS.**
- B is 429'd by A's traffic → every client shares one bucket → **increment and
  re-measure.**

**Both probes must pass at the same value** before `TRUST_PROXY_HOPS` is
recorded as verified. A single passing probe is not evidence — Probe A alone
also passes at a value that is far too low, and Probe B alone also passes at a
value that is far too high.

Probe A sends spoofed headers to the user's own deployment and needs explicit
approval (§10).

## 7. Verifying the 26 OpenAPI operations without exposing Swagger

The inventory is **already** pinned by an exhaustive assertion:
`test/swagger.e2e-spec.ts:63-90` builds its own document with
`SwaggerModule.createDocument` and compares the full operation list with
`toEqual` against 26 literal entries. It never requests `/api/docs`, which is
precisely why `main.ts`'s production gate does not weaken it — a point
`main.ts:31-32` already makes in a comment.

`createDocument` scans the **compiled module graph's controllers**. The module
graph in the production container is built from the same commit, so the local
run is evidence about the deployed surface. The verification is therefore:

1. `npm run test:e2e` locally (and in CI) — the exhaustive `toEqual` passes at
   the deployed commit.
2. `GET https://<app>/api/docs` → **404**, confirming the gate holds in
   production.
3. Spot-check that the *paths* in the inventory resolve on the live deployment,
   which §8's journey does for 11 of the 26 and the auth/health checks for 4
   more.

This is honest about its boundary: step 1 proves the inventory, step 2 proves
the gate, and step 3 proves that a documented path string resolves on the real
server. **No step claims to enumerate production's routes from the outside**,
and no mechanism in this phase can — that is the cost of the gate, and it is
the right trade.

## 8. Verification plan

All checks bounded; no unbounded wait anywhere, per Phase 6's Ruling 22 — *a
control that hangs is not a control*.

### 8.1 Health and cold start

| Check | Expected |
|---|---|
| `GET /health/live` on a warm service | 200 `{"status":"ok"}`, under 1 s |
| `GET /health` on a warm service | 200 `{"status":"ok","timestamp":…}` — **this**, not `/health/live`, is the database-readiness check (locked decision 2) |
| `GET /api/health/live` | **404** — the prefix-exclusion regression test Phase 6 identified as the one that actually catches a mistake |
| `GET /api/v1/health` | 404 — `health` is `VERSION_NEUTRAL` |
| `GET /health/live` after ≥16 min idle, `curl --max-time 180` | 200, with the elapsed time **recorded** (expected ~60 s) |
| `GET /health` immediately after that cold start | 200 — if 503, the Neon wake outran the request; retry once and record both |

### 8.2 Boot log

The single `Bootstrap` line must read `env=production`,
`paymentProvider=stripe`, `maintenanceJobs=disabled`, `swagger=not served`, and
`trustProxyHops=<configured>`. It contains no secret by design, and that
property is re-confirmed by reading the deployed log.

### 8.3 Fresh-database API journey

Against the public HTTPS URL. 11 distinct operations.

| # | Request | Expected |
|---|---|---|
| 1 | `POST /api/v1/auth/login` as the bootstrapped ADMIN | 200 + tokens |
| 2 | `POST /api/v1/admin/categories` `{"name":"Desks","slug":"desks"}` | **201**, returns `id` |
| 3 | `GET /api/v1/categories` | 200, `{data,meta}` containing the new row |
| 4 | `POST /api/v1/admin/products` `{name, description, priceCents: 2500, stockQuantity: 5, categoryId}` | **201** — the step the deferred entry said was impossible before the category route shipped. `currency` omitted → `USD` |
| 5 | `GET /api/v1/products` and `GET /api/v1/products/{id}` | 200 both |
| 6 | `POST /api/v1/auth/register` a fresh customer | 201 |
| 7 | `PUT /api/v1/cart/items/{productId}` `{"quantity":2}` as that customer | 200. Note the parameter is **`productId`**, not `id` |
| 8 | `GET /api/v1/cart` | 200, `totalCents` = 5000 |
| 9 | `POST /api/v1/orders` with header `Idempotency-Key: <8-128 of A-Za-z0-9_->`, **empty body** | **201**, status `PENDING` |
| 10 | Repeat step 9 with the **same** key | **200**, the same order id — idempotent replay, not a second order |
| 11 | `GET /api/v1/orders` and `GET /api/v1/orders/{id}` | 200, the order visible to its owner |

Negative controls, same journey:

| Check | Expected |
|---|---|
| Step 2 with the **customer's** token | **403** — `RolesGuard` |
| Step 2 with **no** token | **401** — `JwtAuthGuard`, global and fail-closed |
| Step 9 with a malformed `Idempotency-Key` | **400** |
| `GET /api/v1/orders/{id}` as a different customer | **404**, not 403 — ownership reads as absence |

### 8.4 Stripe test-mode webhook

| # | Step | Expected |
|---|---|---|
| 1 | `GET /health/live` to **warm the service first** | 200 |
| 2 | `POST /api/v1/orders/{id}/payments`, empty body, as the order's owner | **201** + a client secret. Order total 5000 is inside `USD {50, 99_999_999}` |
| 3 | Complete the payment out-of-band with Stripe's own tooling | provider-side |
| 4 | Signed `payment_intent.succeeded` delivered by Stripe | **200**, and `GET /api/v1/orders/{id}` now reads `PAID` |
| 5 | Replay the same event (`stripe events resend`) | **200**, still `PAID`, exactly one `payments` row — dedupe via `skipDuplicates` |
| 6 | `POST /api/v1/payments/webhook` with a **tampered signature** | **4xx**, order unchanged |
| 7 | Same request with **no** `Stripe-Signature` header | **4xx**, order unchanged |

Step 6 is the one that matters: it is the control proving the deployed secret is
real and verification is live. Without it, step 4 alone is also consistent with
a broken verifier that accepts everything.

**Warming in step 1 is required, not cosmetic.** Stripe retries sandbox
deliveries only **three times over a few hours** (live mode retries for three
days), and a cold start of ~60 s against Stripe's timeout can consume them.
`stripe events resend` remains available for up to 30 days via the CLI.

Register the endpoint as `https://<app>.onrender.com/api/v1/payments/webhook`.
The `https://` form directly — Stripe treats a 3xx as a delivery failure, and
Render redirects HTTP to HTTPS.

### 8.5 Boot-abort guard, against the real host

`PAYMENT_PROVIDER=fake` under `NODE_ENV=production` must abort at boot. Phase 6
asserted this in CI; Phase 7 confirms it on Render by setting the value,
observing a **failed deploy** whose log names `PAYMENT_PROVIDER`, then reverting.
Bounded: if the service instead boots and serves, the guard has regressed and
that is a **blocking** finding.

## 9. Operational limitations, and what is done about each

| Limitation | Source | Mitigation / posture |
|---|---|---|
| Service spins down after 15 min idle, ~1 min cold start | Render free tier | **Accepted and documented.** No keep-alive pinger — see the next row |
| Neon free is 100 CU-h/project/month ≈ 400 compute-hours at 0.25 CU ≈ **13.3 h/day** against a 730-hour month | Neon plans | **Continuous operation is arithmetically impossible on the free plan.** A keep-alive pinger would therefore exhaust the *database* quota around day 16 and suspend compute. This is the quantified reason the obvious workaround is refused |
| Neon compute suspends after 5 min; not disableable | Neon plans | First query after idle pays a wake. `/health` may 503 once on a cold start; `/health/live` cannot, which is why it is the host probe |
| Scheduled jobs do not fire | Render spins down on absence of **inbound** traffic; a cron tick is not inbound | `MAINTENANCE_JOBS_ENABLED=false`, and the sweeps are demonstrated on demand via the shipped `POST /api/v1/admin/maintenance/:job/run`. **Order expiry therefore never fires automatically on the demo** — stated in the README rather than left to be discovered |
| `PrismaService` exits on `$connect()` failure → possible restart loop against a cold Neon | `Dockerfile:91-95` | **Locked decision 5: observe only.** If a loop is actually seen, it is evidence for a follow-up, not licence to change `src/` during Phase 7 |
| No database backups; 1 GB storage cap | Render free PG has none; Neon free has 1 manual snapshot | Demo data is disposable and re-creatable by §8.3. Not a production posture, and §10 says so |
| Render free PG expires in 30 days | Render free tier | Avoided entirely by using Neon |
| Ephemeral filesystem, no persistent disk | Render disks | **Non-issue**: zero file writes in `src/`; `Product.imageUrl` is an external URL. Recorded as verified-absent rather than mitigated |
| Single instance | Render free | In-memory throttler storage is **correct** at one instance. Redis remains deferred with Phase 6's trigger — a second replica — explicitly not met here |
| Bandwidth/build-minute overage suspends free services absent a payment method | Render free tier | Accepted; a demo's traffic is trivial |
| Region fixed after creation | Render regions | One-way door: choose Frankfurt at creation |

## 10. Portfolio demo vs revenue production

**Minimum for a safe portfolio demo** — all in Phase 7's scope:

1. A dedicated managed database; `ecommerce_dev` and `ecommerce_test` untouched.
2. TLS on every database connection; pooled for runtime, direct for migrations.
3. `JWT_SECRET` generated locally, ≥32 chars, entered only into Render's store.
4. `CORS_ORIGIN` an explicit origin, never `*`.
5. `TRUST_PROXY_HOPS` measured in **both** directions (§6), not assumed.
6. Stripe **test** mode only; a real `whsec_`; no live keys; no real charges.
7. Migrations applied before first boot, with `migrate deploy` only.
8. ADMIN bootstrapped with a strong unique password; `ADMIN_PASSWORD` removed
   afterwards. Registration still cannot mint an ADMIN — `CreateUserInput` has
   no `role` field.
9. `/health/live` as the host probe; `/health` throttled and used separately.
10. Swagger **off** in production (§1).
11. No secret in the repository, the logs, or the README.
12. The README states plainly that it is a free-tier demo, that it sleeps, that
    payments are test-mode, and that automatic expiry is disabled.

**Additional for a revenue-taking production service** — all explicitly **out**:

1. Paid non-sleeping compute, ≥2 replicas, and therefore **Redis-backed
   throttler storage with a recorded fail-open vs fail-closed decision**
   (Phase 6's named trigger).
2. Backups with a *tested* restore, plus point-in-time recovery.
3. Live Stripe credentials, **refunds**, and reconciliation **remediation** —
   none of which exist, and none of which this phase adds.
4. Request logging, error tracking, metrics, and alerting on sweep failures and
   the `PROVIDER_UNREACHABLE` counter.
5. Graceful shutdown draining in-flight requests **and** in-flight sweeps.
6. A deliberately assigned liveness/readiness split.
7. Secret rotation, a least-privilege database role, a WAF or DDoS front.
8. Legal and compliance: PCI scope, terms, privacy policy, tax.
9. Load testing against real limits, and capacity planning.

## 11. Scope

**In:** provider setup; configuration; migrations; ADMIN bootstrap; Stripe
test-mode webhook registration and verification; the §8 verification suite;
the `TRUST_PROXY_HOPS` measurement; new `docs/deferred-limitations.md` entries;
a README deployment section; rollback and cleanup procedures.

**Out, deliberately:**

- **Any `src/` change.** Expected diff in `src/`: **empty**. A change is
  permitted only on proven deployment evidence of a blocker, and must be
  justified in writing before it is made (locked decision: "no application code
  changes unless a genuine deployment blocker is proven").
- Registry publishing. Phase 6's D10 stands; its trigger is a second
  environment or a release-audit requirement, neither of which exists.
- Redis, multi-replica scaling, refunds, reconciliation remediation, a confirm
  route, a custom domain, CI-driven deploys, and the `PrismaService` retry of
  locked decision 5.
- Parameterising the Dockerfile `HEALTHCHECK` port. `PORT=3000` makes it
  correct here; the hardcoded form stays and is recorded as a latent trap for a
  host that injects its own port. Phase 6 asserted the current form in CI.

## 12. Sources

Accessed **2026-10-29**.

- Render free tier — https://render.com/docs/free
- Render Docker builds — https://render.com/docs/docker
- Render web services (PORT default 10000, bind 0.0.0.0, TLS) — https://render.com/docs/web-services
- Render deploys (pre-deploy is paid) — https://render.com/docs/deploys
- Render health checks (own path, 5 s budget) — https://render.com/docs/health-checks
- Render disks (none on free, ephemeral FS) — https://render.com/docs/disks
- Render regions (Frankfurt; fixed after creation) — https://render.com/docs/regions
- Neon plans (1 GB, 100 CU-h, 5-min scale-to-zero) — https://neon.com/docs/introduction/plans
- Neon TLS — https://neon.com/docs/connect/connect-securely
- Neon pooling (0.25 CU → 104 connections; no session advisory locks) — https://neon.com/docs/connect/connection-pooling
- Stripe webhooks (HTTPS required, 3xx is failure, sandbox retries 3× over hours) — https://docs.stripe.com/webhooks
- Fly.io pricing (no free tier for new orgs) — https://docs.fly.io/about/pricing

Render's `X-Forwarded-For` behaviour has **no** official documentation; that
absence is why §6 is a measurement.

## 13. Definition of Done

PASS requires evidence recorded for each. Anything unmeasured is
**NOT VERIFIED**, never an assumed pass.

1. `GET https://<app>/health/live` → 200 over public HTTPS.
2. `GET https://<app>/health` → 200 with a timestamp (database readiness,
   verified separately from liveness).
3. `GET https://<app>/api/health/live` → **404**.
4. `GET https://<app>/api/docs` → **404** (§1).
5. `npm run test:e2e` green at the deployed commit, including the exhaustive
   26-operation `toEqual`.
6. Five migrations applied before first app boot, from the `migrate` target,
   over the direct TLS endpoint, exit 0; `maintenance_leases` rows present.
7. ADMIN bootstrapped from the runtime image; re-run reports `unchanged`;
   `ADMIN_PASSWORD` subsequently removed from Render.
8. The §8.3 journey completes end-to-end to a `PENDING` order, including the
   idempotent-replay 200 and all four negative controls.
9. A signature-verified Stripe test event drives `PENDING → PAID`; a tampered
   signature and a missing signature both 4xx and change nothing; a replay
   stays `PAID` with one `payments` row.
10. `PAYMENT_PROVIDER=fake` under production aborts the deploy on the real host,
    with `PAYMENT_PROVIDER` named in the log.
11. `TRUST_PROXY_HOPS` **measured**, both probes passing at the same value, with
    the value and both observations recorded.
12. Cold-start latency measured and recorded, with the Neon CU-hour arithmetic
    stated as the reason no keep-alive pinger exists.
13. Boot log shows `env=production`, `paymentProvider=stripe`,
    `maintenanceJobs=disabled`, `swagger=not served`, and no secret.
14. No secret in the repository, in Render's logs, or in the README.
15. `docs/deferred-limitations.md` gains the §9 entries; the README gains a
    deployment section that does not overclaim.
16. `src/` diff is empty, or any change is justified in writing against proven
    deployment evidence.
17. Rollback and cleanup procedures written and, for rollback, exercised once.
