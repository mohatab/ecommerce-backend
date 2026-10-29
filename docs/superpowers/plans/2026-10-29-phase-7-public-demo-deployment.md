# Phase 7 — Free-tier public portfolio deployment — plan

**Spec:** `docs/superpowers/specs/2026-10-29-phase-7-public-demo-deployment-design.md`
**Base:** `master` at `a84aca7`. **Status:** awaiting approval.

Seven tasks. Tasks 1–3 are operator work with no repository change; Tasks 4–6
produce the evidence; Task 7 is the only task that writes to the repository.

**Every task records PASS or NOT VERIFIED per check.** An unrun check is
NOT VERIFIED — never an assumed pass. A check that cannot run because a
prerequisite failed is NOT VERIFIED with the blocking reason named.

**Standing constraints for every task:** never touch `bash.exe.stackdump`;
never touch `ecommerce_dev` or `ecommerce_test`; no live Stripe keys; no paid
plan; no new dependency; no new migration; no `src/` change absent proven
blocker evidence; secrets never enter the repository, a command recorded in
documentation, or this conversation.

---

## Task 0 — Pre-flight (repository, no accounts)

Confirms the tree is the one the spec was written against.

```bash
git log --oneline -1                 # expect a84aca7
git status -sb                       # expect clean but for untracked bash.exe.stackdump
npm run lint:ci && npm run build && npm test
docker compose up -d postgres-test && npm run test:e2e
```

**Checks**

| # | Check | PASS |
|---|---|---|
| 0.1 | HEAD is `a84aca7` | exact match |
| 0.2 | `lint:ci`, `build`, `test` green | exit 0 each |
| 0.3 | `test:e2e` green, including the 26-operation `toEqual` in `test/swagger.e2e-spec.ts` | exit 0 |

0.3 is the baseline for spec §7: the inventory must be proven green **at the
commit being deployed**, before anything is deployed.

**Blocker:** any red gate stops Phase 7 here. Deploying an unproven commit
would make every later finding ambiguous.

---

## Task 1 — Provider accounts and the database **[MANUAL — user only]**

Claude cannot and will not perform any step in this task.

1. Create a **Neon** account. Create a project in **AWS eu-central-1**
   (Frankfurt).
2. From the Connect dialog, copy **both** strings, each with `sslmode=require`:
   - **direct** (no `-pooler` in the host) — migrations and bootstrap
   - **pooled** (`-pooler` in the host) — the running app
3. Create a **Render** account and connect it to the GitHub repository.
   **Do not create the service yet** — that is Task 3, after migrations.
4. Generate `JWT_SECRET` locally: `openssl rand -base64 48`. Store it in a
   password manager. **Do not paste it into this conversation.**
5. Create a Stripe **sandbox**. Copy the `sk_test_…` secret key.
   **Do not paste it into this conversation.**

**Checks**

| # | Check | PASS |
|---|---|---|
| 1.1 | Neon project region is eu-central-1 | shown in the console |
| 1.2 | Both connection strings obtained and distinguishable by the `-pooler` host | operator confirms |
| 1.3 | `JWT_SECRET` ≥32 characters, generated not invented | operator confirms |
| 1.4 | Stripe key is `sk_test_`, never `sk_live_` | prefix check |

**Approval gate:** the user confirms completion. Claude proceeds on that
confirmation without ever seeing a value.

---

## Task 2 — Migrations, then the ADMIN bootstrap

Order is the whole point: schema before any application boot.

### 2a — Apply the five migrations

```bash
docker build --target migrate -t ecommerce-migrate:phase7 .
docker run --rm -e DATABASE_URL="<NEON DIRECT URL>" ecommerce-migrate:phase7
```

Verified against the tree: the stage is `Dockerfile:31-32`
(`FROM build AS migrate`, `CMD ["npx","prisma","migrate","deploy"]`) and
`prisma/schema.prisma:5-8` reads `env("DATABASE_URL")`, so this container needs
**exactly one** variable and boots no application.

### 2b — Bootstrap the ADMIN

Uses the **runtime** image — the same bytes that will serve traffic — with the
command overridden. The full production environment is required because
`src/scripts/bootstrap-admin.ts:60-66` boots `AppModule` and Joi validates
everything. Command shape is in spec §5 step 7.

`PAYMENT_WEBHOOK_SECRET` is a ≥16-character **placeholder** at this stage. It
satisfies `min(16).required()` for a script that never receives a webhook and
**makes nothing about payments functional**; the real `whsec_` arrives in
Task 4.

**Checks**

| # | Check | PASS | NOT VERIFIED if |
|---|---|---|---|
| 2.1 | Migrate container exits 0 | exit code 0 | non-zero, or not run |
| 2.2 | Five migrations reported applied | all five names in the output | fewer, or output not captured |
| 2.3 | `maintenance_leases` rows exist | queried via the Neon console | not queried |
| 2.4 | Bootstrap logs `Admin bootstrap complete: created` | exact string | other outcome |
| 2.5 | Re-running the bootstrap logs `unchanged` | exact string, and the hash is not rewritten | not re-run |
| 2.6 | No secret appears in any captured output | reviewed line by line | not reviewed |

2.5 matters because it proves idempotence on the real database, which is what
makes the command safe to re-run during later troubleshooting.

**Blocker:** if 2.1 fails on TLS, confirm `sslmode=require` is present and that
the **direct** host was used. If it fails on connectivity, Neon's compute may be
suspended — retry once; a wake is expected to take seconds.

---

## Task 3 — Create and deploy the Render service **[MANUAL — user only]**

Settings, each justified in spec §3–§4:

| Setting | Value |
|---|---|
| Type | Web Service, **Free** |
| Language | **Docker** (Dockerfile path `./Dockerfile`, no target — `runtime` is last) |
| Region | **Frankfurt** — fixed after creation |
| Health Check Path | **`/health/live`** |
| Auto-deploy | operator's choice; record which |

Environment variables — the §4 table in full. `PORT=3000`,
`NODE_ENV=production`, `CORS_ORIGIN` an explicit non-wildcard origin,
`TRUST_PROXY_HOPS=1` **as a candidate**, `PAYMENT_PROVIDER=stripe`,
`MAINTENANCE_JOBS_ENABLED=false`, `DATABASE_URL` = the **pooled** string,
plus `JWT_SECRET`, `PAYMENT_API_KEY`, and `PAYMENT_WEBHOOK_SECRET` (still the
placeholder).

**Checks**

| # | Check | PASS | NOT VERIFIED if |
|---|---|---|---|
| 3.1 | Build succeeds; Render builds the `runtime` stage | build log ends on the runtime stage | build fails |
| 3.2 | Deploy reaches live and the health check passes | Render reports live | health check times out |
| 3.3 | Boot log reads `env=production`, `paymentProvider=stripe`, `maintenanceJobs=disabled`, `swagger=not served`, `trustProxyHops=1` | all five on the one `Bootstrap` line | line absent |
| 3.4 | Boot log contains **no** secret and **no** `DATABASE_URL` | read in full | not read |
| 3.5 | `GET https://<app>/health/live` → 200 | `{"status":"ok"}` | non-200 |
| 3.6 | `GET https://<app>/health` → 200 with a timestamp | database reachable over the pooled TLS endpoint | 503 |

**Blocker — the one to watch.** If the service enters a restart loop whose logs
show a Prisma `$connect()` failure, that is spec §3's identified risk and
locked decision 5 applies: **record it as evidence, do not change `src/` in this
task.** Capture the log, note whether a retry of the deploy succeeds (Neon warm
vs cold), and report. A `src/` change requires its own written justification and
the user's approval.

---

## Task 4 — Stripe test-mode webhook **[MANUAL for registration]**

1. **[MANUAL]** Register the endpoint
   `https://<app>.onrender.com/api/v1/payments/webhook` — the `https://` form
   directly, because Stripe counts a 3xx as a delivery failure and Render
   redirects HTTP→HTTPS. Subscribe to `payment_intent.succeeded`.
2. **[MANUAL]** Reveal the `whsec_…` signing secret.
3. **[MANUAL]** Replace the placeholder `PAYMENT_WEBHOOK_SECRET` in Render with
   it; redeploy.
4. Run spec §8.4 steps 1–7.

**Warm the service with `GET /health/live` immediately before any
`stripe trigger`.** Sandbox deliveries retry only three times over a few hours,
and a ~60 s cold start can consume them. `stripe events resend <id>` remains
available for 30 days.

**Checks**

| # | Check | PASS | NOT VERIFIED if |
|---|---|---|---|
| 4.1 | A signature-verified `payment_intent.succeeded` returns 200 | Stripe shows 200 | timed out / not delivered |
| 4.2 | The order reads `PAID` afterwards | `GET /api/v1/orders/{id}` | not re-read |
| 4.3 | **Tampered** signature → 4xx, order unchanged | 4xx and status still `PENDING` on a second order | not attempted |
| 4.4 | **Missing** `Stripe-Signature` → 4xx, order unchanged | 4xx | not attempted |
| 4.5 | Replaying the delivered event → 200, still `PAID`, exactly one `payments` row | row count queried | not queried |

**4.3 and 4.4 are mandatory controls, not extras.** 4.1 alone is equally
consistent with a verifier that accepts everything, so without them the real
secret is unproven. If 4.3 or 4.4 returns 2xx, that is a **blocking security
finding** and the phase stops.

Nothing in this task creates a second writer of `PAID`: `markPaid()` remains the
only writer and `PaymentWebhookService` its only caller.

---

## Task 5 — Public API verification

### 5a — The fresh-database journey

Spec §8.3, all 11 steps plus the four negative controls, against the public
URL. Exact shapes verified against the DTOs at `a84aca7`:

- `POST /api/v1/admin/categories` → `{"name","slug"}`; `name` is trimmed by a
  `@Transform`, `slug` is not.
- `POST /api/v1/admin/products` → `{name, description, priceCents, categoryId}`;
  `description` is **required** (`@MinLength(1)`); `currency` omitted defaults to
  `USD` via `prisma/schema.prisma:64`; `priceCents` is an integer in minor units.
- `PUT /api/v1/cart/items/{productId}` → `{"quantity": 2}`, `@Min(1) @Max(99)`.
  The parameter is **`productId`**, not `id`.
- `POST /api/v1/orders` → **empty body**, mandatory header
  `Idempotency-Key` of 8–128 chars from `A-Za-z0-9_-`. 201 first, **200** on
  replay of the same key.

Use `priceCents: 2500` and `quantity: 2` → total 5000, inside the payable
`USD {50, 99_999_999}` range so Task 4 can use the same order.

### 5b — Routing, health, and the Swagger gate

| # | Check | PASS |
|---|---|---|
| 5.1 | `GET /api/docs` → **404** | 404 (spec §1 — the gate holding is the correct result) |
| 5.2 | `GET /api/health/live` → **404** | 404 — the regression Phase 6 identified as the one that actually catches a prefix mistake |
| 5.3 | `GET /api/v1/health` → 404 | `health` is `VERSION_NEUTRAL` |
| 5.4 | `GET /health` and `GET /health/live` → 200 | both |

### 5c — Cold start, bounded

Leave the service idle ≥16 minutes, then:

```bash
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 180 \
  https://<app>/health/live
```

Then immediately `GET /health` to observe the Neon wake.

| # | Check | PASS | NOT VERIFIED if |
|---|---|---|---|
| 5.5 | Cold `/health/live` → 200 within 180 s, **elapsed time recorded** | 200 + a number | timeout, or time not captured |
| 5.6 | `/health` right after → 200, or 503 once then 200 on retry | either, **recorded as observed** | not attempted |

`--max-time` is mandatory. An unbounded curl against a service that never wakes
hangs, and a check that hangs is not a check.

### 5d — Boot-abort guard on the real host

Set `PAYMENT_PROVIDER=fake` in Render, redeploy, observe failure, revert.

| # | Check | PASS | NOT VERIFIED if |
|---|---|---|---|
| 5.7 | The deploy **fails** and the log names `PAYMENT_PROVIDER` | both | deploy succeeds → **blocking regression** |
| 5.8 | Reverting to `stripe` restores a healthy deploy | live again | not reverted |

**Checks 5.9–5.12:** the §8.3 journey's steps 1–11 all PASS, and its four
negative controls (403 for a customer on an admin route, 401 anonymous, 400 on a
malformed idempotency key, 404 for another customer's order) all PASS.

---

## Task 6 — Measure `TRUST_PROXY_HOPS`

Spec §6. **Requires the user's explicit approval before running**, because
Probe A sends spoofed `X-Forwarded-For` headers at their own deployment.

Both probes use `POST /api/v1/auth/login` with deliberately **wrong**
credentials, so nothing authenticates and no token is minted. Run against a
**warm** service so a cold start does not distort the 1-minute window.

**Probe A — detects too HIGH (silent bypass).** 10 requests, each a different
spoofed `X-Forwarded-For`.
- Responses settle into 429 → spoofed values are not separate buckets → PASS.
- All 10 return 401 with no 429 → `req.ip` is attacker-controlled →
  **decrement and re-measure**.

**Probe B — detects too LOW (shared bucket).** Exhaust client A's budget from
one real source address; then one request from a genuinely different source
(e.g. a cellular connection).
- B not 429'd → distinct buckets → PASS.
- B 429'd by A's traffic → **increment and re-measure**.

| # | Check | PASS | NOT VERIFIED if |
|---|---|---|---|
| 6.1 | Probe A passes at the configured value | 429 observed | not run / approval withheld |
| 6.2 | Probe B passes at the **same** value | B unaffected by A | only one source available |
| 6.3 | Both observations recorded verbatim | written into Task 7's documentation | not recorded |

**Neither probe alone is evidence.** Probe A also passes at a value far too low;
Probe B also passes at a value far too high. Only both at one value settle it.

If 6.2 cannot run for want of a second independent source address, record
`TRUST_PROXY_HOPS` as **PARTIALLY VERIFIED — Probe A only**, say so in the
deferred limitations, and do not claim the value is confirmed. That is the
honest outcome, and it is better than a claimed pass.

---

## Task 7 — Documentation, rollback, cleanup *(the only repository change)*

Files touched — and no others:

1. **`docs/deferred-limitations.md`** — new Phase 7 entries, each with the
   measurement that justifies it: free-tier sleep and the **recorded**
   cold-start figure; the Neon CU-hour ceiling precluding continuous operation
   and therefore any keep-alive pinger; `MAINTENANCE_JOBS_ENABLED=false`
   meaning **automatic order expiry never fires on the demo**; no backups;
   out-of-band migrations with no host-side release phase on Free; the
   `$connect()`-exit restart-loop risk (with whatever Task 3 observed); the
   hardcoded `HEALTHCHECK` port as a latent trap for a host that injects its
   own `PORT`; and `TRUST_PROXY_HOPS`'s verification status from Task 6.
   **Add entries; close none by deletion.**
2. **`README.md`** — a deployment section: the live URL, the four-step
   `migrate → bootstrap → deploy → register webhook` order, the §4 variable
   table with **no values**, and an honest limitations paragraph (sleeps,
   test-mode payments only, expiry disabled, no backups). The existing line
   *"This is not production-ready, and says so"* stays true and is not softened.
3. **`CLAUDE.md`** — a Phase 7 subsection recording only the non-obvious,
   rediscoverable facts: Render's `PORT` default of 10000 versus the hardcoded
   `HEALTHCHECK`; `/health/live` as the host probe and `/health` as the separate
   readiness check; Render's pre-deploy being paid-only, hence out-of-band
   migrations; Swagger's production gate being a **security** property of
   Express middleware sitting outside the guard chain; the Neon CU-hour
   arithmetic as the reason a keep-alive pinger is refused; and Neon's pooled
   connections not supporting session-level advisory locks, which is why
   Phase 5's `MaintenanceLease` row choice matters in production.
4. **`docs/superpowers/plans/2026-10-29-phase-7-public-demo-deployment.md`** —
   this file, updated with the PASS / NOT VERIFIED table and the measured
   figures.

**Rollback** (documented, and exercised once for the first item):

- Bad deploy → Render's rollback to the previous successful deploy. **Exercise
  this once** and confirm `/health/live` returns 200 afterwards.
- Bad environment variable → correct it and redeploy; `CORS_ORIGIN=*` or a
  missing `TRUST_PROXY_HOPS` aborts boot by design, so the failure is loud.
- Bad migration → **no automatic down path exists.** `migrate deploy` has no
  rollback; recovery is a new forward migration, which is out of Phase 7's
  scope. Stated plainly rather than implied.
- Compromised secret → rotate at the provider, update Render, redeploy. Rolling
  `JWT_SECRET` invalidates every access token, which is the intended effect.

**Cleanup** (documented, not executed):

- Delete the Render service, delete the Neon project, delete the Stripe webhook
  endpoint and roll the sandbox key.
- `ecommerce_dev` and `ecommerce_test` are never involved in any of it.

**Checks**

| # | Check | PASS |
|---|---|---|
| 7.1 | `npm run lint:ci`, `npm run build`, `npm test` green | exit 0 each |
| 7.2 | `git diff --stat` touches only the four files above | no `src/` entry |
| 7.3 | No secret in any changed file | reviewed line by line |
| 7.4 | Every §13 item marked PASS or NOT VERIFIED, none blank | table complete |
| 7.5 | Render rollback exercised once, `/health/live` 200 after | recorded |
| 7.6 | `bash.exe.stackdump` still untracked and unmodified | `git status` |

`npm run test:e2e` is **not** required in Task 7 — the change is documentation
only. It was already proven in Task 0 at the deployed commit, which is where
the spec's §7 evidence comes from.

---

## Acceptance criteria — PASS vs NOT VERIFIED

Spec §13's seventeen items, each resolving to exactly one of:

- **PASS** — the check ran and the recorded observation matches the expectation.
- **NOT VERIFIED** — the check did not run, could not run, or its output was
  not captured. The reason is named. **Never silently upgraded to PASS.**
- **FAIL** — the check ran and contradicted the expectation. A FAIL on items 9
  (webhook signature controls) or 10 (boot abort) is **blocking** and stops the
  phase.

Two items are permitted to land as **PARTIALLY VERIFIED** with the limit stated:

- **Item 11** (`TRUST_PROXY_HOPS`) if only Probe A can run for want of a second
  independent source address.
- **Item 12** (cold start) if the idle window could not be held for a full
  16 minutes.

Everything else is PASS or NOT VERIFIED. Phase 7 is complete when every item
has a recorded verdict, not when every item is green.

---

## Steps requiring the user's account access or explicit approval

**Account access — Claude cannot perform these:**

1. Neon account and project creation (Task 1).
2. Render account creation and the GitHub connection (Task 1).
3. Render service creation and every environment-variable entry (Task 3).
4. Stripe sandbox creation, webhook registration, and revealing `whsec_`
   (Tasks 1, 4).
5. Generating `JWT_SECRET` (Task 1).
6. Removing `ADMIN_PASSWORD` from Render after bootstrap (post-Task 2).
7. Render's rollback exercise (Task 7).

**Explicit approval before proceeding:**

1. **Probe A in Task 6** — it sends spoofed headers at the user's deployment.
2. **Task 5d** — it deliberately breaks the deployment to prove a guard, then
   reverts.
3. **Any `src/` change**, which locked decision 5 and spec §11 forbid absent
   proven blocker evidence plus a written justification.
4. The chosen `CORS_ORIGIN` value and the ADMIN email.

**Never requested in chat, in any task:** passwords, API tokens,
`DATABASE_URL`, `JWT_SECRET`, or any Stripe secret.
