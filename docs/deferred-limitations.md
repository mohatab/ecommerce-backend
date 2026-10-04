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

### Rate limiting keys on `req.ip`, with no trusted-proxy configuration

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

### `refresh_tokens` rows are never deleted

**Owner: Phase 5 (Redis + BullMQ).**

Rotation inserts one row per refresh and only ever sets `revoked_at`; nothing
purges expired or revoked rows. This is disk growth, not a latency problem —
every lookup is by a unique or indexed column — but the table grows without
bound in proportion to total refreshes ever performed.

Phase 5 introduces the background job infrastructure this belongs in. A periodic
job deleting rows where `expires_at` is in the past is sufficient; add an index on
`expires_at` at the same time, since no current query needs one.

### The runtime image's Prisma setup is undeclared and untested

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

### The admin catalog write surface is unreachable on a fresh database without a direct database insert

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

### PENDING orders hold stock indefinitely

**Owner: Phase 5 (Redis + BullMQ).**

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

### A payment that succeeds after its order was cancelled is recorded but not refunded

**Owner: unscheduled (refunds).**

Refunds need a provider refund call, a refund state model, and a policy decision
about who may trigger one — a phase of its own. Phase 4's decision D5
deliberately keeps cancellation unblocked rather than closing the window by
making orders un-cancellable, so the window is accepted rather than removed.

What happens today: the order stays `CANCELLED`, the payment is recorded
`SUCCEEDED`, an error-level log is emitted, and **200** is returned so the
provider stops retrying. The state is queryable —
`payments.status = 'SUCCEEDED'` joined to `orders.status = 'CANCELLED'`.

A future phase must call the provider's refund API for exactly those rows,
exactly once, with its own idempotency guarantee. **Nothing in this codebase
refunds anything today.**

### There is no automated reconciliation between provider state and local state

**Owner: Phase 5 (scheduled jobs).**

A sweep is scheduled work, and scheduled work arrives in Phase 5.

What happens today: every divergence — an event for an unknown order, an amount
or currency mismatch, a divergent `providerPaymentId`, a provider success that
landed while the database was unavailable — is recorded in `payment_events` and
logged at error level, and is detectable by query. But **nothing looks
automatically**, so detection depends on someone reading logs.

A future phase must add a periodic job comparing provider payment state against
local `Payment` and `Order` state, and reporting the divergences.

### `payment_events` rows are never deleted

**Owner: Phase 5 (Redis + BullMQ), alongside the existing `refresh_tokens` purge.**

Identical in shape to that entry. One row per accepted delivery, forever. This
is disk growth, not latency — the only lookup is by a unique index.

A future phase must extend the same purge job, and add an index on the timestamp
used for the cutoff at that time, since no current query needs one.

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
