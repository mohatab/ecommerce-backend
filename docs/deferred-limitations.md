# Deferred limitations

Known, accepted gaps in what ships today, each with the phase that owns it.

This file exists because these decisions previously lived only in the
subagent-driven-development ledger under `.superpowers/`, which is **gitignored** —
invisible in a fresh clone and to anyone reviewing a pull request. A deferred
security limitation that nobody can find has been forgotten, not deferred.

Nothing here is a bug report. Each item was considered and consciously postponed.
**Do not close one by deleting the entry** — close it by shipping the fix, then
saying so here.

---

## Security

### ~~Rate limiting keys on `req.ip`, with no trusted-proxy configuration~~ — CLOSED by Phase 6

**Closed by shipping, not by deletion.** `TRUST_PROXY_HOPS` sets Express's
`trust proxy` in `configureApp()`, and `ThrottlerGuard.getTracker()` returns
`req.ip`, so that one setting governs every bucket — there is no custom tracker.

It is a **numeric hop count, never `true`**: `true` takes the leftmost
`X-Forwarded-For` entry, which is attacker-supplied, and would make the 5/min
login limit unlimited. A number counts from the right, skipping exactly the
proxy-appended entries.

**Required under `NODE_ENV=production` with no default**, because neither default
is safe — `0` behind a proxy collapses every client into one bucket, and a value
above the real chain depth is a silent bypass. The deployer states the topology,
which is what the original entry asked for.

**One hop is the reference topology for the tests, not a universal value.** It
must be set per deployment to the number of proxies that will append to
`X-Forwarded-For`, and **too high is the dangerous direction** — too low degrades
availability loudly, too high removes the control silently.

Controls C-D1 and C-D2 are recorded failing against `trust proxy: true` and
against no setting at all, respectively. C-D1's vacuity was checked explicitly: a
single-entry `X-Forwarded-For` cannot discriminate the two settings, so the
control uses a two-entry header.

**The original entry is preserved verbatim below, per this file's no-deletion rule.
It describes the PRE-Phase-6 state: its present tense and its `Owner: Phase 6` line
are historical, not current.**

---

**Owner: Phase 6 (deployment) — must be settled before the API sits behind a proxy.**

`ThrottlerGuard` buckets by `req.ip`. Nothing calls `app.set('trust proxy', …)`,
so behind a reverse proxy, load balancer, or CDN, Express reports the *proxy's*
address for every request. Both failure modes are bad and neither is loud:

- **Without `trust proxy`:** every client collapses into one bucket. The
  5-per-minute limit on `login` becomes 5 per minute *for the entire internet* —
  a trivial denial of service against all users at once.
- **With `trust proxy` enabled naively:** `X-Forwarded-For` is attacker-supplied,
  so any caller can rotate the header and bypass the limit entirely.

The correct setting depends on the deployment topology (how many proxies sit in
front, and which are trusted), which is why it is not guessed at now. Whoever
deploys this must set it deliberately.

Direct-to-Node deployments are unaffected.

### Registration reveals whether an email is already in use

**Owner: none — accepted by design.** See the Phase 1 design spec §15.

`POST /auth/register` returns 409 for a duplicate address, which confirms that
address is registered. Closing it requires always returning 201 and moving
confirmation to email, and no phase of this roadmap has mail infrastructure.

Note the asymmetry is deliberate, not an oversight: **login** goes to
considerable lengths to avoid the same leak (unconditional argon2 verification
against a boot-derived dummy digest), because login is the endpoint an attacker
would grind. Registration is rate-limited to 5/minute, which bounds enumeration
speed without eliminating it.

### A reconciliation finding's `detail` is exposed verbatim to administrators

**Owner: unscheduled — a hardening deliberately not taken.**

`GET /api/v1/admin/reconciliation/findings` returns each finding's `detail` JSON
exactly as it was written. Nothing sanitises it at the edge, and the response DTO
maps it straight through.

What makes that safe today is **where the values come from, not what the edge
does with them**: every `detail` object in the codebase is built by one of six
producers in a single file, and each writes only opaque references and numbers —
`providerPaymentId`, amounts in minor units, currency codes, statuses,
timestamps. No provider payload, client secret, API key, signature, or raw
webhook body is ever placed in one. The route is `ADMIN`-only on top of that.

The hardening not built: typing `detail` as a **union** of those six shapes
instead of `Prisma.JsonValue`. That would make a future producer leaking a new
field a **compile error** rather than something a reviewer has to notice. It was
judged not worth the type machinery while all six producers are in one file and
reviewable together — which is exactly the condition that would stop being true
first, so revisit this when a second file starts writing findings.

### Refresh-token families have no absolute lifetime

**Owner: unscheduled.**

Every rotation issues a successor with a *fresh* full `JWT_REFRESH_TTL`, so a
family that is used regularly never expires. This is ordinary sliding-window
behaviour and reuse detection still bounds a stolen token's usefulness, but there
is no hard ceiling on how long a single lineage can live. If a maximum session
age is ever required (a compliance regime usually forces this), it needs an
absolute expiry recorded at family creation and checked on every rotation.

---

## Operations

### ~~`refresh_tokens` rows are never deleted~~ — CLOSED by Phase 5

**Closed by shipping, not by deletion.** `MaintenancePurgeService` deletes rows
whose `expires_at` is past `REFRESH_TOKEN_RETENTION_DAYS` (default 30, Joi floor
7), oldest first, and the `expires_at` index the original entry asked for shipped
in the same migration.

The cutoff is on `expires_at`, **never** `created_at`: a long-lived valid token
must never be deleted, and a revoked-but-unexpired row is retained because it is
reuse-detection evidence — deleting it early would turn a detectable replay into
an unknown token. Control C-P1 (dropping the cutoff predicate) is recorded failing
on exactly those two assertions.

**What remains, and it is a capacity limit rather than a defect:** the purge
deletes at most `MAINTENANCE_PURGE_BATCH_SIZE` rows **per table per day**
(default 1000, daily at 03:00), against a Phase 1 design that rotates a refresh
token on **every use**. A deployment refreshing more than a thousand times a day
accumulates faster than it purges. A saturated batch logs at `warn` naming the
table, which makes the condition **visible, not impossible**. Raise the batch
size or the cadence when that warning appears.

### The runtime image's Prisma setup is undeclared and untested — PARTLY CLOSED by Phase 6

**Closed by shipping:** CI now **runs** the image rather than only building it —
it migrates a throwaway database from a `migrate` image, serves, reports healthy
through Docker's own health state, and stops with exit 0. The migration path ships
as an artifact built from the same Dockerfile and the same commit as the server,
so a migration can no longer be applied from a different checkout than the running
image. The serving image carries no Prisma migration CLI **and no schema engine**.

**That took an explicit prune, and the reason is the generalisable part.**
`npm ci --omit=dev` did **not** achieve it: `prisma` is an optional *peer*
dependency of the production `@prisma/client`, so the lockfile marks it
`devOptional`, and `--omit=dev` omits only `dev`. Measured at **6.19.3 inside the
built image** before the prune existed. `@prisma/engines` rode in the same way,
carrying the schema engine that actually applies migrations. **The lesson outlives
this phase: a `devDependencies` declaration is not an absence guarantee when a
production dependency peer-depends on the same package** — and four green
verification gates did not notice.

**Precisely what that does and does not establish:** it is a **tooling boundary,
not a capability boundary**. The standard Prisma migration CLI and the schema
engine are absent, so `prisma migrate deploy` cannot be invoked there. It does
**not** prove schema mutation is impossible — `PrismaService` extends
`PrismaClient`, which exposes `$executeRaw` and `$executeRawUnsafe`, and the
database role is whatever `DATABASE_URL` supplies. No DDL exists in `src/` today
(the only raw SQL is the health check's `SELECT 1`), so it is a latent capability
rather than an exercised one. Closing it needs a least-privilege application role
distinct from the migration role — a database administration decision, out of
scope for Phase 6. **Trigger:** a real deployment exists whose database
credentials this project controls.

**Still open:** the runtime stage copies the generated client via
`node_modules/.prisma`, a layout Prisma does not contract — and **the prune now
depends on that layout**, because the generated client's own copy of the query
engine is what survives when `@prisma/engines` is removed. That raises the stakes
without changing the trigger: a Prisma major upgrade that relocates the generated
engine would break the serving image's **query path**, not merely its tidiness.
**Owner: unscheduled. Trigger: a Prisma major upgrade.**

**The original entry is preserved verbatim below, per this file's no-deletion rule.
It describes the PRE-Phase-6 state: its present tense and its `Owner: Phase 6` line
are historical, not current.**

---

**Owner: Phase 6 (deployment).**

Two related gaps in `Dockerfile`:

- The runtime stage copies the generated client from the build stage
  (`node_modules/.prisma`) after `npm ci --omit=dev`. This works, but depends on
  generated-output layout that is not part of Prisma's public contract.
- The `prisma` CLI is a devDependency, so `prisma migrate deploy` **cannot run
  from the runtime image**. That is consistent with the foundation spec's rule
  that migrations run as a discrete release command and never at application
  boot, but it means the release process must supply the CLI separately.

Compounding both: CI **builds** the image but never **runs** it, so "the image
builds" is currently the only assurance — it is not evidence that the container
starts, connects, and serves. A smoke test that boots the image against a
throwaway database belongs with the deployment work.

### Redis-backed throttler storage is deferred, with a trigger rather than a date

**Owner: unscheduled. Trigger: a second replica.**

**Recorded here for the first time in Phase 6.** The decision itself predates this
file's Phase 6 pass — it lived only in `CLAUDE.md`'s tech-stack notes, which is
exactly the invisibility this file exists to fix.

Rate limiting uses `@nestjs/throttler`'s **in-memory** storage. At Phase 6's
topology — a **single instance** — that is *correct* rather than a compromise: one
process, one bucket store, no coordination to get wrong.

What changes with more than one: with `N` replicas and in-memory storage the
effective limit is **`N × limit` per client**, because buckets do not share. The
login control degrades from 5/minute to **5N/minute** — weakened, not eliminated.

**The trigger is a second replica, not a date.** And whoever adds Redis must
decide, explicitly and in writing, between **fail-open** (storage unreachable →
rate limiting silently disappears, exactly when infrastructure is degraded and
probing is most likely) and **fail-closed** (a cache outage becomes a total API
outage). Neither is right in general. **That choice is the work, not the wiring.**

### Shutdown drains neither in-flight requests nor in-flight sweeps

**Owner: unscheduled. Trigger: a deployment that cannot tolerate a dropped
request or a stalled maintenance job during a rollout.**

`SIGTERM` is handled and the process exits **0** — CI asserts that within 10s on an
idle container. Two things are *not* proven:

- **In-flight HTTP requests are not proven to drain under load.** The assertion is
  made against an idle container, so a request in flight at the moment of
  `SIGTERM` may be lost. Nest's shutdown hooks run, but no test holds an open
  request across the signal.
- **A container stopped mid-sweep may be killed before the maintenance runner's
  `finally` releases its lease.** The lease then stays held until it lapses — up to
  `MAINTENANCE_LEASE_SECONDS` (default 300s) — during which that job reports
  `skipped: lease-held`. This is **safe**: a lapsed lease is exactly the recovery
  path designed for a crashed holder, and no work is lost or duplicated. It is a
  latency cost, not a correctness one.

### Liveness and readiness have different semantics, and the probe assignment must be honoured

**Owner: whoever configures the orchestrator. Trigger: none — this is a standing
operational constraint.**

`/health/live` is process-only: synchronous, no I/O, no database. `/health` queries
the database and returns **503** when it is unreachable. They are not
interchangeable, and the asymmetry is load-bearing:

- **Point liveness and the container `HEALTHCHECK` at `/health/live`.**
- **Point readiness at `/health`.**
- **Never point liveness at `/health`.** `PrismaService.onModuleInit()` exits the
  process when `$connect()` fails, so a restart cannot succeed while the database
  is down — the restart actively prevents the reconnection that the running
  container would have made on its own through Prisma's pool. A transient outage
  becomes an unbootable crash loop.

Nothing in the application can enforce this; it is a deployment-time choice, which
is why it is recorded as a limitation rather than a guard.

### The scheduler registers crons before the HTTP port is bound

**Owner: unscheduled. Trigger: a job whose first tick must not precede readiness.**

`MaintenanceScheduler.onModuleInit()` registers every cron through
`SchedulerRegistry`, and `onModuleInit` runs **before** `app.listen()`. A tick can
therefore fire while the port is still binding. Harmless today — the sweeps do not
depend on the HTTP server, and the lease plus the per-order CAS make a concurrent
tick safe — but it means "the process is scheduling work" and "the process is
serving traffic" are not the same instant, and a job that ever needed readiness
first would have to say so.

### `TRUST_PROXY_HOPS` is verifiable only through throttling behaviour

**Owner: unscheduled. Trigger: adding request logging.**

No request logging exists, so there is **no direct log signal** for the resolved
client IP or the hop count in effect. The boot log states the configured number,
but nothing afterwards shows what `req.ip` actually resolved to per request. A
misconfigured hop count is therefore observable only indirectly:

- **Too low** collapses clients into one bucket — loud, because unrelated callers
  start seeing each other's 429s.
- **Too high** is a silent bypass — the limit simply stops applying, and nothing
  logs that it did.

**Too high is the dangerous direction and the one with no signal.** Until request
logging exists, the only way to confirm the setting is to reason about the
topology and test the throttle from a known position in the chain.

### The serving image's lack of migration tooling is a tooling boundary, not a capability boundary

**Owner: unscheduled. Trigger: a real deployment whose database credentials this
project controls.**

Cross-referenced from the runtime-image entry above, and repeated here because it
is the claim most likely to be overstated by someone skimming.

C-D10 proves the standard Prisma migration CLI and the schema engine are **absent**
from the serving image — and, just as importantly, that `npm ci --omit=dev` alone
did **not** make them so. It does **not** prove schema mutation from a serving
container is impossible: `$executeRaw` and `$executeRawUnsafe` remain on the
client, and the database role is whatever `DATABASE_URL` supplies. They are unused
for DDL today; the only raw SQL in `src/` is the health check's `SELECT 1`.

Closing this needs a **least-privilege application role distinct from the
migration role**, which is a database administration decision with its own
migration story for existing deployments. **No document produced by Phase 6 may
state that schema mutation from a serving container is impossible.**

### The runtime image still carries the migration SQL it cannot apply

**Owner: unscheduled. Trigger: a measured need to shrink the serving image, or a
deployment whose threat model objects to the schema being readable in the
container.**

`COPY prisma ./prisma` puts `schema.prisma` and all five migration directories into
the serving image. They are **data, not tooling** — nothing in the pruned image can
execute them — but two consequences follow:

- The schema and its full migration history are **readable from a serving
  container**.
- They inflate the image for no purpose the generated client is **known** to need: it
  resolves its own schema copy under `node_modules/.prisma/client/` (verified by
  inspection, not by building without the `COPY`).

Removing them is a separate change with its own verification, deliberately **not**
bundled into the migration-tooling prune, because the prune's safety argument is
about engine binaries and would not transfer.

### The admin catalog write surface is unreachable on a fresh database without a direct database insert — PARTLY CLOSED

The heading is **not struck through**, because half of this entry is still
open.

**Closed by shipping, once an ADMIN exists** (the compiled bootstrap script is
still required first, and it is not the API): `POST /api/v1/admin/categories`
now exists
(`src/modules/categories/admin-categories.controller.ts`), admin-only through a
single class-level `@Roles(Role.ADMIN)`. A fresh database therefore accepts a
product through the API alone: create a category, then create a product against
the returned `id`. That journey is asserted end to end by
*"lets an ADMIN create a product against a category created through the API"* in
`test/admin-categories.e2e-spec.ts`, which runs against a truncated database and
uses nothing but HTTP. Duplicate `name` or `slug` returns 409 through
`HttpExceptionFilter`'s existing `P2002` map, with no local `try/catch` — a
control that swallowed the error in the service was recorded returning 500
instead.

**Still open — the other half of this entry.** A deactivated product's id is
still unrecoverable through the API. `DELETE /api/v1/admin/products/:id` is a
soft deactivation reversible with `PATCH { "isActive": true }`, but only by a
caller who already holds the id: no admin product list ships, the public list
excludes inactive products, and the public detail route 404s on one. Once an id
is lost the row is undiscoverable through the API even though it still exists.
**Owner: unscheduled.** Closing it needs an admin product list, which is its own
task.

Two things this closure deliberately did **not** change: category deletion is
still unimplemented, because it needs the orphan policy Phase 2 declined to
invent, and `Product.category`'s `onDelete: Restrict` is untouched.

And one consequence worth stating, because it needs no orphan policy and so is
not excused by the argument above: **`CategoriesService.update()` also still has
no route.** It ships, and is unit- and e2e-tested, but a mistyped `name` or
`slug` cannot be corrected through the API — it is permanent, publicly visible in
the catalog, and its unique value is consumed. `name` is also stored untrimmed,
so `'Desks'` and `'Desks '` are two rows that render identically; both
behaviours are pinned by tests rather than fixed, because changing either is a
decision for whoever owns the catalog. A category write route for corrections is
its own task.

**The original entry is preserved verbatim below, per this file's no-deletion
rule. It describes the state before the category route shipped.**

---

**Owner: unscheduled.**

Phase 2 ships no admin category write route. `CategoriesService.create()` and
`.update()` exist but have no HTTP caller anywhere in `src/` — the only
category route is the public `GET /api/v1/categories`. `Product.categoryId`
is required, so on a fresh database `POST /api/v1/admin/products` returns 409
(`P2003`, no such category) for every request, forever, until a category row
exists by some means other than the API. An operator who bootstraps an ADMIN
on a new deployment can authenticate but cannot create a single product
through the API; the only way in is inserting a category directly in the
database.

The same unreachability affects reversal: `DELETE /api/v1/admin/products/:id`
is a soft deactivation, recoverable with `PATCH { "isActive": true }`, but
only by a caller who already holds the product's id. No admin list route
ships, the public list excludes inactive products, and the public detail
route 404s on one — so once an id is lost, the row is undiscoverable through
the API even though it still exists.

Both gaps close the same way: an admin category write route and an admin
product list, matching what spec §7.2 originally scoped before both were
deferred during implementation.

### ~~PENDING orders hold stock indefinitely~~ — CLOSED by Phase 5

**Closed by shipping, not by deletion.** The `order-expiry` sweep transitions a
`PENDING` order past its deadline to `EXPIRED` and restores every line's stock in
**one transaction per order**, so a partial restoration is impossible. The
deadline is stored on the order at checkout (`expires_at`), 30 minutes by default;
an order whose payment was initiated gets 24 hours **and** is only expired once
the provider confirms the payment did not succeed. Unknown provider state fails
closed — the order stays `PENDING`.

The fix is not the one the original entry proposed. It does **not** reuse
`cancel()`: an expiry is not a customer cancellation, and conflating them would
have made a system action indistinguishable from a user action in the order
history and in `cancel()`'s own idempotent 200. `expire()` is its own
compare-and-swap on the same `status: PENDING` predicate, so restoration stays
exactly-once across any interleaving of expiry, cancel, and the payment webhook.

The original text is preserved below because the reasoning it records is still
the reasoning that governs the shipped code.

---

Checkout decrements stock immediately (`CheckoutService.checkout()`), so an
order that is never paid and never cancelled holds its units forever. There
is no expiry, because expiry needs scheduled jobs, which arrive in Phase 5.

Mitigation today: a customer can cancel their own `PENDING` order
(`POST /api/v1/orders/:id/cancel`) and the stock returns immediately, through
the same compare-and-swap `OrdersService.cancel()` already uses. The exposure
is therefore bounded by customer behaviour, not by an attacker — but a bot
could still hold inventory by checking out and never paying.

The fix is a periodic job that cancels `PENDING` orders older than a
configured age, reusing the existing cancellation path (design spec §5.6) so
restoration stays exactly-once. Do not implement a bespoke expiry that writes
stock directly.

**Phase 4 amendment.** Phase 4 increases the rate at which such orders appear,
because an abandoned payment attempt leaves a `PENDING` order behind. The
mitigation is unchanged — the customer can cancel — and the fix is unchanged: a
periodic job reusing the existing cancellation path.

**Phase 5 amendment (what is still true after the fix).** Not every `PENDING`
order is reachable by the sweep: an order whose `expires_at` is `NULL` — one
created before this migration — is **never** selected, by design, because
inventing a deadline for it retroactively would expire orders their owners were
never told had one. Such rows stay cancellable and are expected to drain
naturally. And the exposure window is now the TTL rather than forever: a bot can
still hold inventory for up to 30 minutes per checkout.

### A payment that succeeds after its order was cancelled or expired is recorded but not refunded

**Owner: unscheduled (refunds).**

Refunds need a provider refund call, a refund state model, and a policy decision
about who may trigger one — a phase of its own. Phase 4's decision D5
deliberately keeps cancellation unblocked rather than closing the window by
making orders un-cancellable, so the window is accepted rather than removed.

What happens today: the order stays `CANCELLED`, the payment is recorded
`SUCCEEDED`, an error-level log is emitted, and **200** is returned so the
provider stops retrying. The state is queryable —
`payments.status = 'SUCCEEDED'` joined to `orders.status = 'CANCELLED'`.

**Phase 5 amendment.** `EXPIRED` joins `CANCELLED` here, and it widens the entry
rather than restating it: a cancellation is a customer action, while an expiry is
a **system** action, so this window can now open with no human involved on either
side. The sweep narrows it as far as it can without authority it must not have —
a tier-B order is never expired while the provider reports its payment
`succeeded`, and never while the provider cannot be asked — but a success landing
*after* the sweep's read still lands on an `EXPIRED` order whose stock was
already restored.

Phase 5 also made the condition **discoverable** rather than only loggable:
reconciliation records it as a finding, so
`GET /api/v1/admin/reconciliation/findings` lists exactly the rows owing a refund.
Detection is all it does.

A future phase must call the provider's refund API for exactly those rows,
exactly once, with its own idempotency guarantee. **Nothing in this codebase
refunds anything today.**

### Reconciliation detects divergence but never remediates it

**Detection closed by Phase 5, by shipping. Remediation remains open, owner:
unscheduled (it is the refund phase).**

The `payment-reconciliation` sweep compares local `Payment` and `Order` state
against the provider every 15 minutes and writes one `reconciliation_findings`
row per `(orderId, kind)` — an upsert, so a divergence seen on ten passes is one
row with `occurrences = 10`, and a finding whose condition clears gets
`resolvedAt` set and is re-opened on the same row if it recurs.
`GET /api/v1/admin/reconciliation/findings` lists the active ones.

**It writes nothing else.** No order, payment, or product row is ever touched by
reconciliation (design decision D5), and the whole code path is structurally
asserted to yield only `reconciliationFinding` writes. So a detected divergence
is a report an operator must act on, by hand, today.

Four things about the detector are worth knowing before trusting a dashboard
built on it:

- **Candidate selection is local-first.** Reconciliation only ever asks the
  provider about payments *it already has rows for*. A payment that exists only
  on the provider's side is invisible to it — see the orphan-discovery entry
  below.
- **The `PROVIDER_UNREACHABLE` counter is per-process and in memory.** The
  threshold counts *consecutive ticks*, so after a restart a genuine outage takes
  up to `RECONCILE_PRECHECK_FAILURE_THRESHOLD` ticks to **raise** the finding.
  That is a late alarm, never a false all-clear: a failed read can never resolve
  an open `PROVIDER_UNREACHABLE`, only a successful one can. Durability would
  need a column the schema does not have.
- **Resolution re-evaluates only the oldest `RECONCILE_BATCH_SIZE` open
  findings.** It converges oldest-first across ticks, but that is a **ceiling,
  not an invariant**: with more open findings than the batch size, the newest can
  wait several ticks to be re-checked.
- **A mass of `PROVIDER_PAYMENT_NOT_FOUND` usually means a misconfiguration, not
  N divergences.** Stripe answers `resource_missing` for an id belonging to
  another account or the other key mode, so a test/live key swap classifies every
  payment as not-found. The job logs one error-level hint naming
  `PAYMENT_PROVIDER` and the API key when that happens — but the hint requires
  `notFound === providerReads`, so a **single** failed read in the same tick
  silences it while the per-order findings are still recorded.

### `reconciliation_findings` rows are never deleted

**Owner: unscheduled.**

The same shape as the two tables Phase 5 purges, and deliberately not purged with
them. A finding is the only durable record that a money-path divergence was ever
observed, so a retention cutoff is a **policy** decision about how long that
evidence is kept — not the mechanical "this row is past its expiry" judgement the
other two purges make. Growth is bounded in practice by `UNIQUE (order_id, kind)`:
a recurring divergence advances `occurrences` on one row instead of inserting.

A future phase must decide a retention policy — most likely resolved findings
older than N days, never active ones — and extend `MaintenancePurgeService` with
it. Until then this table only grows, and `failed` would count it as a third
table if it were added naively (that field counts **tables** in the purge and
**orders** in the other two jobs).

### Provider-side orphan discovery is not implemented

**Owner: unscheduled.** See the Phase 5 design spec §8.6.

Reconciliation is local-first by design: it compares the provider's view of
payments **we already know about**. A payment intent that exists on the provider
and has no local `Payment` row at all — created by a request whose response never
reached us, or by something outside this API — is therefore never discovered.

Closing it needs a **fifth capability on the `PaymentProvider` port**: listing or
searching the provider's payments by time range. Nothing today justifies it. The
port currently has four methods, each with a caller, and the one deliberate
omission (`confirmPayment`) is omitted precisely because a method with no caller
invites one. A listing method would also be the first provider call whose cost
and page count scale with the provider's data rather than with ours.

The partial mitigation that already exists: every webhook delivery is recorded in
`payment_events` whether or not it matched a local order, so an event for an
unknown order is discoverable by query even though no sweep looks for it.

### ~~`payment_events` rows are never deleted~~ — CLOSED by Phase 5

**Closed by shipping, not by deletion.** The same purge job deletes rows older
than `PAYMENT_EVENT_RETENTION_DAYS` (default 90, Joi floor 30), and the
`created_at` index the original entry asked for shipped in the same migration.

The retention is three times the refresh-token one, and that is the point:
this table is the **webhook idempotency ledger**. Deleting a row makes a replayed
delivery from before the cutoff newly processable, so the cutoff is really an
answer to "how late can a provider redeliver?" rather than a disk-space number.
The 30-day floor is there so nobody can tune it down to a week without noticing
that trade.

The same daily batch ceiling applies as for `refresh_tokens`: at most
`MAINTENANCE_PURGE_BATCH_SIZE` rows per tick, with a `warn` when a batch
saturates.

### A missing `maintenance_leases` row makes its job silently unrunnable

**Owner: unscheduled — an operational hazard, not a defect.**

Every maintenance job claims its lease with an `UPDATE` whose predicate travels
with the write. That is deliberate: there is no `INSERT` anywhere on the path, so
no code can ever race on creating a lease row. The three rows are seeded by the
Phase 5 migration, one per job name.

The consequence is that if a row is **removed** — a manual `TRUNCATE
maintenance_leases`, a restore from a dump taken before the migration, or a job
name added in code without a matching migration — that job can never acquire and
will never run again. It is not silent in the logs: `acquire()` reports
`'missing'` distinctly from `'held'`, and the runner logs that case at **error**
level precisely so a routine "lease is held" warning cannot hide it. But nothing
self-heals, and no alert exists unless someone is watching the logs.

`test/helpers/reset-leases.ts` is `updateMany`-only for the same reason, which
means it **frees** leases and never recreates them: a suite that truncates the
table outside `prisma migrate reset` is not repaired by calling it.

Restoring a row by hand is enough to recover (`holder` empty, `expires_at` at the
epoch). A future phase wanting this to be impossible should make the seed part of
a startup assertion that aborts boot on a missing row, rather than an upsert on
the acquire path.

### Not every `PENDING` order is payable

**Owner: none — accepted by design.** See the Phase 4 design spec §5.4 and C4.

Phase 3's `MAX_TOTAL_CENTS` is the `INT` bound and predates any payment
provider. Narrowing it at checkout would couple the order domain to a provider's
price list and retroactively invalidate persisted orders, so it stays wider than
the payable range.

What happens today: an order whose total is outside the payable range
(`USD → { 50, 99_999_999 }` minor units, the **lowest** documented provider
tier, because the payment method is unknown at initiation), or whose currency is
not supported for payment, returns **422** on `POST /api/v1/orders/:id/payments`
— **before any provider call**, so no intent is ever created for it. The order
remains valid and cancellable, and its stock returns on cancel.

A future phase must do nothing, unless a product decision says such orders
should be impossible to create — at which point the constraint belongs in
checkout, with a migration story for existing rows.

### Payment initiation's stale-read window is benign

**Not a limitation — recorded so that nobody chases a bug that does not exist.**

Initiation reads the order and then reads the payment row in two separate
statements, so a webhook can commit between them. That is real, and it is
harmless: the stale-read window between initiation's order read and payment read
is benign (200 via retrieve); a 502 there means provider unavailability, not a
defect.

Why it cannot corrupt anything: `recordPayment` and `markPaid` commit
**atomically** in one transaction, so a webhook-created payment row always
arrives together with the order leaving `PENDING`. A later initiation therefore
hits the 409 status guard before it can reach `retrievePayment`. The order is
`PAID`, with exactly one `payments` row and one `payment_events` row, in every
interleaving.

`test/payments-concurrency.e2e-spec.ts` admits 502 in one concurrent case
because `FakePaymentProvider` only holds ids it minted itself; a real provider
always recognises the intent it just created and sent a webhook about, so
`retrievePayment` succeeds there and the outcome is 200.

---

## Testing

### The e2e suite must stay serial (`maxWorkers: 1`)

**Owner: unscheduled — a standing constraint, not a to-do.**

`test/helpers/truncate.ts` reads `pg_tables` and then builds a `TRUNCATE` from the
result, with no lock between the two statements. Concurrent workers sharing one
database race there — confirmed to fail intermittently on a cold cache.

`maxWorkers: 1` in `test/jest-e2e.json` is the mitigation, and several things now
quietly depend on it: `test/factories/user.factory.ts` hands out sequential emails
that only stay unique because nothing runs in parallel.

**Do not raise `maxWorkers` until per-worker database isolation exists.** Raising
it produces intermittent, misleading failures that look like application bugs.

### The "no provider call inside a transaction" guard is constructor-only

**Owner: unscheduled — a stated limit on a structural test, not a gap to fix
blindly.**

Phase 4's absolute rule — no external I/O inside a database transaction — is
enforced mechanically by a `Reflect.getMetadata('design:paramtypes', …)`
assertion on `PaymentWebhookService` and, since Phase 5, on `OrdersService` too.
It is a strict `toEqual` over the whole parameter array, so it catches a provider
injected by class (it appears as its own class) and one injected by token (it
erases to `Object`, but the array length changes).

**What it does not catch:** a provider reached through an **existing**
dependency — say, if `ProductsService` grew one — through a property assigned
after construction, or through a module-level import rather than DI. It also
cannot distinguish a provider from any other new constructor parameter: it fails
on *any* added parameter, which is deliberate, because the intended reaction is a
human reading the diff rather than a machine deciding.

Do not read a green run of it as "no provider is reachable from the transaction".
Read it as "the constructor gained no new way to reach one".

### The lease's fencing is proven by consequence, not by mechanism

**Owner: unscheduled — a limit on what the tests establish.**

Phase 5's mutual exclusion is a `maintenance_leases` row re-asserted inside the
same transaction as every mutation. The tests prove the **consequence**: an
instance whose lease was taken over cannot commit — its transaction rolls back
with `LeaseLostError` and the order stays `PENDING` with stock unrestored — and
`assertHeld`'s write really does participate in the caller's transaction rather
than running on another connection.

They do **not** prove the row-lock *mechanism* by which PostgreSQL serialises two
concurrent `assertHeld` writers against the same lease row. No test in this
repository distinguishes "the row lock serialised them" from "they happened not
to overlap". The design argument for the mechanism is sound and is written up in
the design spec; it is simply not something this harness demonstrates.

This matters because it is the same shape as Phase 3's C3 result — sorted lock
acquisition is mandatory as a discipline without having been demonstrated as the
mechanism preventing a deadlock. The honest position in both cases: the shipped
behaviour is correct under everything tested, and the explanation of *why* is
argued rather than measured.

The recorded control that does discriminate (C-E2, Task 7) is worth knowing:
removing the lease acquire **and** the fence makes both instances report
`completed` — exclusion is gone — while the stock is **still** restored exactly
once, because the per-order compare-and-swap, not the lease, is what prevents the
double restore. The lease prevents wasted work; the CAS prevents wrong work.

### Real provider network behaviour is not covered by CI

**Owner: unscheduled.**

CI has no provider credentials by design (Phase 4 design spec §12.3), and real
network behaviour cannot be made deterministic.

What happens today: `FakePaymentProvider` covers every branch of the service
layer and the full signature pipeline — it signs with HMAC-SHA256 over the raw
body and verifies in constant time, so it is not a weaker verifier than the
thing it stands in for. The Stripe adapter's signature verification is
unit-tested offline using the SDK's own test header generator. Its **HTTP**
behaviour — real retries, real error shapes, the real intent lifecycle — is
exercised only by hand against Stripe test mode. Mitigated by keeping the
adapter thin enough to read in one sitting.

A future phase must add a manually triggered smoke test against provider test
mode, kept out of the required CI path.

### The test database persists between runs

Not a defect, but it surprises people. The e2e Postgres is tmpfs-backed and wiped
only on **container restart** — not between `npm run test:e2e` invocations. A suite
using fixed email addresses must call `truncateAll()` (see `test/auth.e2e-spec.ts`)
or generate unique addresses per run (see `test/auth-guard.e2e-spec.ts`). Either
works; a suite that does neither passes once and then 409s forever.
