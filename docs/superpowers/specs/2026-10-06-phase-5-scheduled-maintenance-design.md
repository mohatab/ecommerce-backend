# Phase 5 — Scheduled Maintenance, Order Expiry, and Payment Reconciliation

**Status:** design spec — approved, not implemented
**Date:** 2026-10-06 (revised 2026-10-07)
**Baseline:** `master` @ `20ac59c` (Phase 4 merged via PR #8)
**Predecessor spec:** `docs/superpowers/specs/2026-09-23-phase-4-payments-design.md`

---

## 1. Objective

Phases 1–4 built a complete synchronous path: register → browse → cart → checkout → pay.
Every state transition requires an inbound HTTP request. **Nothing happens on its own.**

Phase 5 makes the system self-correcting. It closes four limitations that are
structural rather than cosmetic, all four already recorded in
`docs/deferred-limitations.md` with **Owner: Phase 5**:

1. A `PENDING` order holds inventory **forever** if the customer neither pays nor
   cancels — and Phase 4 *increased* the rate at which these appear, because an
   abandoned payment attempt leaves one behind.
2. `refresh_tokens` grows without bound.
3. `payment_events` grows without bound.
4. Every payment divergence is detectable by query, but **nothing looks** —
   detection depends on a human reading logs.

### 1.1 Why this is the phase after Payments

Phase 4 is what made (1) and (4) urgent. Before money moved, an unpaid `PENDING`
order was a bookkeeping curiosity. Now it holds real inventory against a payment
that may have succeeded at the provider while our row says otherwise.

### 1.2 Capability added

The capability is **time-based, system-initiated state correction**: the first
transitions in this codebase that no user requests.

---

## 2. Scope

### 2.1 In scope

| # | Feature | Closes |
|---|---------|--------|
| F1 | Scheduling infrastructure (`@nestjs/schedule` + a transactional database lease) | enabler |
| F2 | `OrderStatus.EXPIRED` and the lifecycle decision it forces | enabler |
| F3 | Order expiry sweep with exactly-once, all-or-nothing stock release | PENDING stock holding |
| F4 | `refresh_tokens` purge | refresh-token growth |
| F5 | `payment_events` purge | payment-event growth |
| F6 | Payment reconciliation — **detection and reporting only** | no automated reconciliation (detection half) |
| F7 | Provider-contract extension exposing payment status (§7) | prerequisite for F3 and F6 |
| F8 | Admin maintenance API | operability and testability of F3–F6 |
| F9 | `expiresAt` on the order response DTO | client countdown |
| F10 | Documentation amendment moving Redis/BullMQ off Phase 5 | roadmap honesty |

### 2.2 Explicitly out of scope

| Excluded | Why — with source |
|----------|-------------------|
| **Refunds** | `deferred-limitations.md`: *"Owner: unscheduled (refunds)."* Needs a provider refund call, a refund state model, and a policy decision about who may trigger one. |
| **Reconciliation remediation** | The deferred entry requires a job that *"report[s] the divergences"*. Remediation means refunding or force-paying; both belong to the refunds phase. |
| **Provider-side orphan discovery** | Requires a fifth port capability (listing provider payments we hold no row for). Not justified by anything in this repository today. **Explicitly deferred — see §8.6.** |
| **Redis, BullMQ, Redis-backed throttling** | Decision D2 (§3.2). No Phase 5 workload is queue-shaped. |
| **Caching** | No measured latency or load problem. Caching adds invalidation coupling to every admin write for no present benefit. |
| **Trusted-proxy configuration** | `deferred-limitations.md`: *"Owner: Phase 6 (deployment)."* Depends on topology. |
| **Running the Docker image in CI** | Phase 6. |
| **A confirm-payment route** | Phase 4 D11 stands: completion is out-of-band. |
| **Any change to Phase 4 payment authority** | The webhook remains the sole writer of `PAID`. See §6.4. |
| **Historical event storage for findings** | One row per `(orderId, kind)` with counters, not an append-only observation log. See §8.5. |

---

## 3. Locked decisions

### D1 — `OrderStatus.EXPIRED` is a new enum member

Expiry does **not** reuse `CANCELLED`.

Reusing `CANCELLED` would permanently conflate "the customer changed their mind"
with "the customer never came back" — the single most useful signal this phase
produces, and unrecoverable from the orders table once merged.

The precedent exists: Phase 4 added `PAID` via `ALTER TYPE … ADD VALUE` in one
migration.

**The cost is a feature.** `OrdersService.markPaid()` ends in an exhaustive
`switch` over `OrderStatus` with **no `default` arm**, and its own comment states
this exists so that adding a fourth member makes the switch non-exhaustive and
the function fail to compile — "That forces a deliberate decision for the new
status instead of silently labelling it `cancelled`." Phase 5 is the case that
tripwire was built for. It must be satisfied by a deliberate new arm, never by a
`default`.

### D2 — Redis, BullMQ, Redis-backed throttling, and caching are deferred

Phase 5 uses `@nestjs/schedule` plus a transactional database lease (§9.3).

1. **Redis would make expiry *worse*.** The natural queue design is a delayed job
   per order ("expire X at T+TTL"). That job is a single point of loss: a Redis
   flush, an eviction, or a queue drained during an incident loses that expiry
   **permanently**, because the trigger *was* the message. A sweep re-derives
   eligibility from committed PostgreSQL state every tick, so it is self-healing.
   On an inventory-and-money path, self-healing beats precise.
2. **No Phase 5 workload is queue-shaped.** Two `DELETE`s by predicate, one CAS
   status transition, and a read-only comparison. That is a timer and a lock.
3. **The exclusion primitive this project already proved is the CAS**, used in
   `markPaid`, `cancel`, `decrementStock`, `adjustStock`, and
   `RefreshTokenService.rotate`. §9.3 reuses it rather than importing a broker.
4. `CLAUDE.md`: *"Do not add dependencies beyond what the current phase actually
   needs."*

**Consequence — documentation must be amended, not silently diverged from.**
`README.md:23` names Phase 5 "Redis caching & BullMQ background jobs" and
`CLAUDE.md:17` says Redis-backed throttler storage "waits for Phase 5". Both are
committed promises and both are now wrong. Task 7 amends them to say Redis and
BullMQ await a workload that genuinely needs a broker, naming the candidates:
**transactional email** and **refunds** — per-item, external I/O, independent
backoff, must survive restart.

### D3 — The provider read is a veto, never an authority

A provider status read may **prevent** an expiry. It may **never** cause a
transition to `PAID`. The webhook remains the sole writer of `PAID` (Phase 4 D9,
C6). This preserves Phase 4 authority exactly.

### D4 — Provider unavailability fails **closed**

An order whose provider status cannot be determined is **not expired**. See §6.3
for the tabulated tradeoff.

### D5 — Reconciliation reports; it never mutates domain state

Reconciliation writes only `ReconciliationFinding` and `MaintenanceLease` rows.
It never touches `orders`, `payments`, or `products`.

### D6 — Mutual exclusion is a transactional lease row, not a PostgreSQL advisory lock

Locked in §9.3, with the rejected alternatives and their specific failure modes.

### D7 — Reconciliation detects divergence from the **local** side only

Every finding class is reachable from a local `Payment`/`Order` row plus
`retrievePayment()`. No class requires enumerating provider-side state. See §8.6.

---

## 4. Lifecycle and state transitions

### 4.1 The state machine after Phase 5

```
                         ┌──────────────► PAID        (webhook only)
                         │
  (checkout) ──► PENDING ┼──────────────► CANCELLED   (order owner only)
                         │
                         └──────────────► EXPIRED     (expiry sweep only)
```

`PAID`, `CANCELLED`, and `EXPIRED` are all **terminal**. There is no transition
out of a terminal state, and none between terminal states.

### 4.2 Authority table

| Transition | Authority | Mechanism | Exactly-once |
|------------|-----------|-----------|--------------|
| → `PENDING` | `CheckoutService` | `tx.order.create` inside the checkout transaction | `(userId, idempotencyKey)` unique |
| `PENDING` → `PAID` | **Webhook only** | `markPaid()` CAS: `updateMany({ where: { id, status: PENDING } })` | CAS; `count === 1` wins |
| `PENDING` → `CANCELLED` | **Order owner only** | `cancel()` CAS: `updateMany({ where: { id, userId, status: PENDING } })` | CAS; only the winner restores stock |
| `PENDING` → `EXPIRED` | **Expiry sweep only** | **New** `expire()` CAS: `updateMany({ where: { id, status: PENDING } })` | CAS; only the winner restores stock |

**All three terminal transitions compete on the same `status = PENDING`
predicate.** Mutual exclusion between them is therefore free: PostgreSQL
re-evaluates the `WHERE` against the committed row, so exactly one of a racing
set matches. No new locking primitive is introduced for this, and none may be.

### 4.3 `markPaid()` gains an `EXPIRED` arm

`MarkPaidOutcome` gains `'expired'`. The new `switch` arm returns it. The webhook
treats `'expired'` exactly as it treats `'cancelled'`: **log at error level,
mutate nothing, return 200** so the provider stops retrying. It is distinguished
from `'cancelled'` in the log message only, because the operator response differs
— a lapse is a system-initiated release; a cancel was a customer action.

Adding a `default` arm to satisfy the compiler is **forbidden**: it would defeat
the tripwire for the next status.

### 4.4 `cancel()` and the `EXPIRED` branch

`cancel()`'s CAS-miss classifier currently splits `PAID` (409 "Order is already
paid") from already-`CANCELLED` (idempotent 200, no second restore). It gains an
`EXPIRED` branch returning **409 `Order has expired`**.

Rationale: unlike already-`CANCELLED`, this is not the caller's own prior action
being replayed idempotently — the order was released by the system and the stock
is gone. A 200 would imply "your cancellation succeeded", which is misleading.
409 matches the `PAID` branch's shape: a terminal state the caller did not cause.

### 4.5 Expiry atomicity — all-or-nothing, in one transaction

**Mandatory and non-negotiable.** For a single order, these four effects occur in
**one** `prisma.$transaction` and either all commit or none do:

1. the CAS transition `PENDING → EXPIRED`,
2. the `expiredAt` timestamp,
3. the lease-ownership re-assertion (§9.3.4),
4. `incrementStock` for **every** `OrderItem` of that order.

**A partial stock restoration must be impossible.** An order whose transition
commits while only some of its items were restored would silently destroy
inventory, and no later sweep would correct it — the order is no longer `PENDING`,
so nothing re-selects it. This is the single most important invariant in the
phase.

Effects (1) and (2) are one statement:
`updateMany({ where: { id, status: PENDING }, data: { status: EXPIRED, expiredAt: now } })`.
`expiresAt` is **never** mutated by expiry; it records the deadline, and
`expiredAt` records the action.

**The restoration path is the existing one.** `expire()` reads the order's items
ordered by `productId` ascending and calls
`ProductsService.incrementStock(tx, productId, quantity)` — the same method
`cancel()` uses, through the caller's `tx`. No new stock-mutation path is
introduced, and none may be.

`deferred-limitations.md` is binding here: *"The fix is a periodic job that
cancels `PENDING` orders older than a configured age, reusing the existing
cancellation path … so restoration stays exactly-once. **Do not implement a
bespoke expiry that writes stock directly.**"*

Ascending `productId` lock ordering is preserved, matching Phase 3's discipline in
`CheckoutService.checkout()` and `OrdersService.cancel()`.

**One transaction per order, not per batch.** A batch-wide transaction would make
one failing order roll back 99 correct expiries, and would hold product row locks
for the whole batch. Per-order transactions bound both.

---

## 5. Expiry semantics and race handling

### 5.1 `expiresAt` is stored, not computed

`Order` gains `expiresAt DateTime?`, written by `CheckoutService` at order
creation as `now + TTL`.

1. **A later TTL change must not retroactively expire history.** With a computed
   TTL, shortening the config would make a large set of old orders instantly
   eligible — a mass stock release triggered by a config edit. With a stored
   value, the TTL is a property of the order as created.
2. **Deterministic tests without clock mocking.** An e2e test creates an order
   with `expiresAt` in the past and the sweep selects it. No fake timers, no
   injected `Clock` abstraction, no new seam. See §14.6.

`expiresAt` is nullable so the migration needs no backfill decision for existing
rows; rows with `expiresAt IS NULL` are **never selected** by the sweep (§5.4).

### 5.2 Two tiers, because the two populations differ in what can be checked

The decisive asymmetry, verified against the code:

- **Tier A — no `Payment` row.** There is no `providerPaymentId`, so
  `retrievePayment()` **cannot be called at all**. There is nothing to look up.
- **Tier B — a `Payment` row exists with `status = PENDING`.** The
  `providerPaymentId` is known, so provider status is checkable.

An order whose `Payment.status = SUCCEEDED` is never a candidate: its order is
already `PAID`, so the `PENDING` predicate excludes it.

### 5.3 TTL values and rationale

#### Tier A — no `Payment` row: **30 minutes** (`ORDER_EXPIRY_TTL_MINUTES=30`)

**This value is a policy choice, and the spec says so rather than faking a
derivation.** The technical analysis yields only a lower bound, and that lower
bound is unverified:

- A tier-A order usually means the customer checked out and never initiated
  payment. Nothing is in flight.
- But the Phase 4 spec documents a residual case in its timeout table — *"client
  timeout after provider acceptance, local row NOT written"* — a crash between
  `createPayment()` and the row insert. Such an order has a **live provider intent
  and no local row**, and therefore no id we can check.
- The correct lower bound for that case is the provider's intent lifetime, which
  is **provider-specific and not verified in this repository**. Phase 4's rule
  applies: do not invent provider behaviour.

30 minutes is chosen as policy, with two system-grounded sanity checks: it is
twice `JWT_ACCESS_TTL` (`15m`), so a customer whose access token lapsed
mid-checkout has a full refresh cycle to return; and it is well above
`WEBHOOK_TOLERANCE_SECONDS` (300s), the window inside which a signed webhook is
accepted at all.

**Residual risk, accepted and recorded:** a crashed-initiation order paid after
expiry produces stock restored for a paid order. It is caught by reconciliation
(§8.3, `PROVIDER_SUCCESS_LOCAL_NOT_PAID`) and it is the *existing* accepted
refund-owed window, now reachable one additional way. Phase 5 does not create it;
Phase 5 makes it detectable for the first time.

#### Tier B — `Payment` row, `status = PENDING`: **24 hours** (`ORDER_EXPIRY_PAYMENT_STARTED_TTL_HOURS=24`)

**This value is derived from a documented number already in the repository.**

The Phase 4 spec records that the provider retains idempotency keys *"for a
bounded window (documented as at least 24 hours)"*, and Phase 4's entire C3
resolution exists because an initiation replayed **after** that window must still
return the persisted intent — which is why the port has `retrievePayment` at all.

24 hours aligns the order's life with the window Phase 4 already treats as the
provider's behavioural boundary. Expiring a payment-started order sooner would
destroy the order that the local `Payment` row exists to guarantee, while the
provider may still honour the same idempotency key.

It is bounded above by the same reasoning: past 24 hours the provider key is
pruned, so holding the order longer protects nothing the local row does not
already protect.

### 5.4 Sweep selection predicate

```sql
status = 'PENDING'
AND expires_at IS NOT NULL
AND expires_at <= now()
AND (
      -- Tier A: no payment was ever initiated
      NOT EXISTS (SELECT 1 FROM payments WHERE payments.order_id = orders.id)
      -- Tier B: initiated but unresolved. The longer TTL is enforced
      -- per-candidate in application code, because it is measured from the
      -- payment row, not the order row.
   OR EXISTS (SELECT 1 FROM payments
               WHERE payments.order_id = orders.id
                 AND payments.status = 'PENDING')
    )
ORDER BY expires_at ASC
LIMIT :batchSize
```

Tier B's 24-hour clock is applied in application code against `Payment.createdAt`
rather than folded into `expiresAt`, so that a single order carries one
`expiresAt` — its tier-A deadline — and a tier promotion is observable rather
than a silent in-place rewrite of the order's deadline.

### 5.5 Per-candidate algorithm

The sweep runs in two phases so that **no provider call is ever inside a
transaction** (Phase 4's absolute rule) while the write phase stays atomic.

**Phase 1 — read and vet (no transaction, no lock held on rows):**

For each selected candidate:

1. **Tier B only:** if `now < Payment.createdAt + paymentStartedTtl`, **skip** —
   not yet eligible.
2. **Tier B only:** call `provider.retrievePayment(providerPaymentId)`.
   - **succeeded** → **do not expire.** Record finding
     `PROVIDER_SUCCESS_LOCAL_NOT_PAID`. Leave the order `PENDING`. **Do not mark
     it `PAID`** (D3 — the read is a veto, never an authority).
   - **pending** → vetted; proceed to Phase 2.
   - **not found or unmatched** → **do not expire.** Record finding
     `PROVIDER_PAYMENT_NOT_FOUND` (§8.3). Treated as unknown, which fails closed.
   - **unavailable, timeout, or error** → **do not expire** (D4, §6.3). Increment
     the consecutive-failure count; at `RECONCILE_PRECHECK_FAILURE_THRESHOLD`,
     record `PROVIDER_UNREACHABLE` so a stuck order becomes visible rather than
     silently immortal.
3. **Tier A only:** no pre-check is possible (§5.2). Vetted; proceed.

**Phase 2 — commit (one transaction per vetted order, §4.5):**

Re-assert lease ownership, CAS `PENDING → EXPIRED` with `expiredAt`, and
`incrementStock` every item — all in that one transaction. `count === 0` on the
CAS means another transition won the race: **do nothing, and restore no stock.**

Phase 1's provider read is deliberately *stale* by the time Phase 2 commits. That
is safe because Phase 2's CAS is the authority: if the webhook marked the order
`PAID` in between, the CAS matches nothing and the expiry does not happen.

### 5.6 Race matrix

| Race | Resolution | Stock outcome |
|------|------------|---------------|
| Expiry vs. owner cancel | Both CAS on `status = PENDING`; exactly one matches | Restored **once**, by the winner |
| Expiry vs. webhook `markPaid` | Both CAS on `status = PENDING`; exactly one matches | If expiry wins: restored once, then `markPaid` returns `'expired'`, logs at error level, returns 200. If the webhook wins: `expire()` sees `count === 0` and restores nothing |
| Expiry vs. expiry, same instance | The lease makes the second tick a no-op (§9.3) | Restored **once** |
| Expiry vs. expiry, two instances | The lease is re-asserted **inside** each commit transaction, so an instance that lost the lease cannot commit (§9.3.4); and the per-order CAS makes a second attempt a `count === 0` regardless | Restored **once** |
| Expiry vs. admin trigger | Same lease as the scheduled job (§10.1) | Second caller receives **409** |
| Provider says succeeded, webhook arrives during the same tick | Order is left `PENDING`; the webhook's CAS succeeds normally and marks it `PAID`; the finding is resolved on the next reconciliation pass (§8.5) | No restoration; correct |
| Partial failure mid-restoration | The whole per-order transaction rolls back (§4.5); the order stays `PENDING` and is re-selected next tick | No partial restoration |

**The window Phase 5 does not close:** a provider success that lands after a
tier-A expiry. Tier A has no id to pre-check. This is the accepted refund-owed
window (`deferred-limitations.md`, *"A payment that succeeds after its order was
cancelled is recorded but not refunded"*, Owner: unscheduled). Phase 5 extends
that entry to name `EXPIRED` alongside `CANCELLED`, and makes the condition
**detectable** for the first time. It does not refund.

---

## 6. Payments after Phase 4

### 6.1 Successful payment arriving near expiry

Tier B: prevented by the pre-check (§5.5 Phase 1 step 2). Tier A: not
preventable; see §5.6. In both cases the webhook's behaviour on an
already-terminal order is unchanged from Phase 4 — log loudly, mutate nothing,
return 200.

### 6.2 Already-terminal order receiving a success

Unchanged Phase 4 behaviour, with `EXPIRED` joining `CANCELLED` on that path.
`Payment` is still recorded `SUCCEEDED`; the order is **not** transitioned; an
error-level log is emitted; 200 is returned. **Nothing in this codebase refunds
anything, and Phase 5 does not change that.**

### 6.3 Provider unavailable during expiry — the tabulated tradeoff

**Decision (D4): fail closed. Do not expire an order whose provider status is
unknown.**

| | Fail open (expire anyway) | Fail closed (skip, retry next tick) |
|---|---|---|
| If the payment had succeeded | Stock restored for a paid order → **oversell, money taken for goods released to someone else, and an owed refund** | Nothing wrong happens |
| If the payment had not succeeded | Correct outcome, slightly sooner | Order holds stock one tick longer |
| Blast radius of a provider outage | Every payment-started order in the outage window is wrongly released | Payment-started orders are released late |
| Recovery | Manual, per order, and involves money | Automatic on the next successful tick |

The costs are asymmetric: fail-open can take money for goods it gave away;
fail-closed only delays an inventory release. During a prolonged outage,
fail-closed degrades to **exactly today's behaviour** — the limitation this phase
improves — rather than to a corrupt state. A degraded system that matches its own
previous release is an acceptable failure mode; one that oversells is not.

`PROVIDER_PAYMENT_NOT_FOUND` is treated the same way, for the same reason: an id
the provider does not recognise is unknown state, not evidence of non-payment.

### 6.4 Phase 4 payment authority is unchanged

Phase 5 adds **no** writer of `PAID`. The structural assertion from Phase 4 must
continue to hold and must be re-verified in Phase 5's suite: `markPaid()` is the
only code in `src/` that writes `OrderStatus.PAID`, and `PaymentWebhookService`
is its only caller. Reading provider status for detection is not authority to
transition.

### 6.5 Stale local payment state

A `Payment` row stuck at `PENDING` whose provider intent succeeded is precisely
finding kind `PROVIDER_SUCCESS_LOCAL_NOT_PAID`. Phase 5 **reports** it. Resolving
it requires either replaying the webhook or a remediation path, both out of scope.

### 6.6 Provider behaviour this spec does not assume

Not assumed, because unverified in this repository: provider retry schedules,
event ordering guarantees, intent expiry semantics, and rate-limit behaviour. The
design depends on none of them — it re-derives truth from `retrievePayment()` at
read time. The one provider fact it does rely on is the **≥24-hour
idempotency-key retention** already documented in the Phase 4 spec (§5.3). Any
stronger claim must be verified against the provider's own documentation before
it enters code.

---

## 7. Provider-contract extension (F7)

### 7.1 The problem, verified against the code

`ProviderPayment` is:

```ts
export interface ProviderPayment {
  providerPaymentId: string;
  clientSecret: string;
  amountMinorUnits: number;
  currency: string;
}
```

**There is no status field.** `retrievePayment()` therefore cannot answer "did
this payment succeed?" — which both the expiry pre-check (§5.5) and reconciliation
(§8) require. This is a hard prerequisite, not an optional nicety.

### 7.2 Decision: extend `ProviderPayment`, do not add a fifth method

```ts
export type ProviderPaymentStatus = 'succeeded' | 'pending';

export interface ProviderPayment {
  providerPaymentId: string;
  clientSecret: string;
  amountMinorUnits: number;
  currency: string;
  /** Phase 5. Provider-reported status at read time. */
  status: ProviderPaymentStatus;
}
```

Why extend rather than add a method:

- The port documents itself as deliberately minimal, listing what is absent on
  purpose. A fifth method widens the contract surface; a field on an existing
  return type does not.
- Every adapter already constructs a `ProviderPayment`, so the compiler locates
  every site that must decide the value. A new interface method could be left
  unimplemented behind a default.

`'pending'` deliberately covers **every** non-success state — requires-action,
processing, canceled, failed. Phase 5 only ever asks "may I release this stock?",
and the answer is identical for all of them. Modelling the provider's full status
vocabulary would be inventing provider behaviour (§6.6) to no benefit.
`SUPPORTED_EVENT_TYPE` is already `'payment_intent.succeeded'`, so the binary
split matches the shape Phase 4 already committed to.

### 7.3 Not-found is an error, not a status

`retrievePayment()` **rejects** when the provider does not recognise the id — it
does not return a third status value. The caller classifies the rejection:

- a provider "no such payment" error → `PROVIDER_PAYMENT_NOT_FOUND`
- any other failure (network, timeout, 5xx, rate limit) → `PROVIDER_UNREACHABLE`

Keeping not-found off `ProviderPaymentStatus` preserves the binary meaning of
"may I release this stock?" and avoids a third enum member that every consumer
would have to handle identically to `'pending'`.

### 7.4 Adapter obligations

- `FakePaymentProvider`: returns `'pending'` by default; test controls
  `markNextRetrieveSucceeded(providerPaymentId)`, `failNextRetrieve()`, and
  `notFoundNextRetrieve()` mirror the existing `failNextCreate` /
  `mismatchNextCreateAmount` style.
- `StripePaymentProvider`: maps the retrieved intent's status to `'succeeded'`
  only for the provider's documented success value, and `'pending'` otherwise.
  The mapping must be written from provider documentation at implementation time
  and must not be guessed. It is also where `PAYMENT_PROVIDER_TIMEOUT_MS` is
  applied (§15.2).
- `createPayment()` returns `status: 'pending'` — a freshly created intent has not
  succeeded. This is a statement about our own call, not a claim about the
  provider.

---

## 8. Reconciliation — detection and reporting only

### 8.1 What it does

A periodic job that compares provider payment state against local `Payment` and
`Order` state and records divergences. It **never mutates** `orders`, `payments`,
or `products` (D5).

### 8.2 Candidate selection — always local-first

Every candidate set is a query over **local** rows. This is what makes
`ReconciliationFinding.orderId` always available (D7).

Bounded per tick (`RECONCILE_BATCH_SIZE`), oldest first:

1. **Unresolved payments.** `Payment.status = PENDING` and
   `Payment.createdAt <= now - RECONCILE_MIN_AGE_MINUTES` and
   `Payment.createdAt >= now - RECONCILE_LOOKBACK_DAYS`. Young rows are skipped
   because an in-flight payment is not a divergence. The lookback bound keeps the
   candidate set from growing without limit as the table ages; anything older is
   permanently stale and already has a finding from when it was in range.
2. **Refund-owed.** `Payment.status = SUCCEEDED` joined to
   `Order.status IN (CANCELLED, EXPIRED)`. Needs no provider call.
3. **Open findings.** Every `ReconciliationFinding` with `resolvedAt IS NULL`,
   re-evaluated so findings can be resolved when the condition clears (§8.5).
   Without this set, a finding on a payment that has since left set (1) — because
   it became `SUCCEEDED` — would stay open forever.

### 8.3 Finding kinds

All six are detectable from a local row plus `retrievePayment()`. None requires
enumerating provider state.

| Kind | Condition | Provider call | Local anchor |
|------|-----------|---------------|--------------|
| `PROVIDER_SUCCESS_LOCAL_NOT_PAID` | provider reports `succeeded`, local `Payment.status = PENDING` | yes | `Payment` |
| `PAID_ORDER_TERMINAL_UNPAYABLE` | local `Payment.status = SUCCEEDED`, order `CANCELLED` or `EXPIRED` (refund owed) | no | `Payment` + `Order` |
| `AMOUNT_MISMATCH` | provider `amountMinorUnits` ≠ `Order.totalCents` | yes | `Payment` + `Order` |
| `CURRENCY_MISMATCH` | provider `currency` ≠ `Order.currency` | yes | `Payment` + `Order` |
| `PROVIDER_PAYMENT_NOT_FOUND` | local `Payment.providerPaymentId` cannot be found or matched by `retrievePayment()` | yes (rejects) | `Payment` |
| `PROVIDER_UNREACHABLE` | the read failed `RECONCILE_PRECHECK_FAILURE_THRESHOLD` consecutive times | attempted | `Payment` |

`ReconciliationFindingKind` is a TypeScript union of exactly these values.

### 8.4 `ReconciliationFinding` schema

```prisma
model ReconciliationFinding {
  id          String    @id @default(uuid(7))
  orderId     String    @map("order_id")
  order       Order     @relation(fields: [orderId], references: [id], onDelete: Restrict)
  paymentId   String?   @map("payment_id")
  kind        String
  detail      Json
  occurrences Int       @default(1)
  firstSeenAt DateTime  @default(now()) @map("first_seen_at")
  lastSeenAt  DateTime  @default(now()) @map("last_seen_at")
  resolvedAt  DateTime? @map("resolved_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  @@unique([orderId, kind])
  @@index([kind, resolvedAt])
  @@map("reconciliation_findings")
}
```

`orderId` is **required** and every kind supplies it (§8.3). `paymentId` is
nullable only because a future kind may be order-level; all current kinds set it.
`onDelete: Restrict` matches every other order-referencing relation in this
schema; findings must not become silently removable by deleting an order.

### 8.5 Finding lifecycle — one row per divergence, with an active/stale distinction

`@@unique([orderId, kind])` is the core of the design. A recurring divergence is
**one row whose counters advance**, never a flood of rows. Without it, a single
stuck payment observed every fifteen minutes produces ~96 rows a day and the
findings table becomes the log file it was meant to replace.

**Three transitions, and no others:**

| Event | Write |
|-------|-------|
| **First observation** | `create`: `occurrences = 1`, `firstSeenAt = lastSeenAt = now`, `resolvedAt = null` |
| **Seen again** | `update`: `occurrences = { increment: 1 }`, `lastSeenAt = now`, `resolvedAt = null`, `detail` replaced with the current observation |
| **Condition no longer holds** | `update`: `resolvedAt = now`. Counters are left alone. |

Implemented as a single `upsert` keyed on `(orderId, kind)` for the first two, so
two concurrent passes cannot produce a duplicate-key error.

- **A resolved finding that recurs is re-opened**, not duplicated: the same row
  gets `resolvedAt = null` and `occurrences` continues from where it was. That is
  why `occurrences` is not reset — the operator wants to know this has happened
  eleven times, not once since the last clear.
- `firstSeenAt` is the audit value and is **never** rewritten.
- **Nothing is ever deleted** by the lifecycle. A resolved finding is history.

**Active vs stale, operator-facing (§10.3):** `resolvedAt IS NULL` **is** the
definition of active. The list endpoint defaults to `resolved=false` so an
operator sees only current divergences without asking, and `resolved=true`
retrieves the historical ones. The alertable number is
`COUNT(*) WHERE resolved_at IS NULL`, grouped by `kind`.

**No observation-history table.** The counters plus `firstSeenAt`/`lastSeenAt`
answer "how long, how often, still happening?", which is every operational
question Phase 5 has. A per-observation log would be a second unbounded table
serving no question the counters do not already answer.

### 8.6 Provider-side orphan discovery is explicitly deferred

A *provider-side* orphan — a payment that exists at the provider for which we
hold **no** `Payment` row — is **not detectable by this design and is out of
scope.** Detecting it requires enumerating provider payments, which means a fifth
port capability (a `listPayments`-style method with pagination and a time
window).

That capability is **not justified by anything in this repository today**: no
route, job, or report needs it, and adding it would widen a port whose
minimality Phase 4 deliberately documented. It is therefore deferred, and Task 7
records it as a new deferred limitation naming the capability it would require.

The nearest thing Phase 5 *does* detect is the local mirror image —
`PROVIDER_PAYMENT_NOT_FOUND`, a local row pointing at a provider payment that
cannot be found or matched. That is reachable with the existing retrieval-based
port and carries a real `orderId`.

---

## 9. Scheduling architecture

### 9.1 `@nestjs/schedule`, in-process

One new runtime dependency: `@nestjs/schedule`. `ScheduleModule.forRoot()` is
registered in `AppModule`. Three `@Cron`-annotated methods live in a new
`MaintenanceModule` under `src/modules/maintenance/`, which owns its own
controller, service, and DTOs like every other feature module.

### 9.2 The cron method is a one-line delegate

Each scheduled method does nothing but call a service method that carries no
scheduling concern:

```ts
@Cron(process.env.ORDER_EXPIRY_CRON ?? CronExpression.EVERY_5_MINUTES)
async scheduledOrderExpiry(): Promise<void> {
  await this.runner.run('order-expiry');
}
```

(The cron expression reaches the decorator through `ConfigService` at module
setup, not by reading `process.env` in the module body — `src/config/` remains the
only reader of `process.env`.)

This matters for testability: **tests call `runner.run()` directly**, never the
cron. No timer is advanced, no scheduler is mocked, and the admin trigger (§10)
reaches exactly the same code path as the schedule. It is also why the admin
route is specified rather than optional — it is the production-safe expression of
the seam the tests already need.

### 9.3 Mutual exclusion: a transactional lease row (D6)

#### 9.3.1 Why PostgreSQL advisory locks were rejected

Verified against this repository, not assumed:

- `PrismaService` is a bare `PrismaClient` (`src/prisma/prisma.service.ts`) with a
  **connection pool** and no connection-pinning API. Prisma offers no way to run
  two separate `$queryRaw` calls on a guaranteed-identical connection.
- **`pg_advisory_lock` (session-scoped) is therefore unusable.** The lock would be
  taken on whichever pooled connection served the acquire, the matching
  `pg_advisory_unlock` could land on a different connection and silently fail, and
  the still-locked connection would be handed back to the pool to serve unrelated
  queries while holding a maintenance lock. A leaked lock of this kind would
  disable the job until process restart, with no visible cause.
- **`pg_try_advisory_xact_lock` (transaction-scoped) cannot cover the execution
  window.** The lock lives exactly as long as its transaction. The sweep must make
  provider HTTP calls, and Phase 4 forbids external I/O inside a transaction
  absolutely; and expiry commits **one transaction per order** (§4.5), so the
  window spans many transactions plus network time. A transaction long enough to
  cover it would also exceed the project's own `TX_TIMEOUT_MS = 10_000`.

Claiming an xact-scoped lock protects a multi-transaction sweep would be false,
so this spec does not use advisory locks for the sweeps at all. **The e2e
harness's own `pg_try_advisory_lock` (`E2E_LOCK_KEY = 728374651n`) is untouched
and unrelated** — it is held for a whole test run on a dedicated client and has
none of these constraints.

#### 9.3.2 The lease model

```prisma
model MaintenanceLease {
  job         String   @id
  holder      String
  acquiredAt  DateTime @map("acquired_at")
  heartbeatAt DateTime @map("heartbeat_at")
  expiresAt   DateTime @map("expires_at")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@map("maintenance_leases")
}
```

`job` is the primary key, so there is exactly one lease row per job for all time.
The migration **seeds one row per job name** with `expiresAt` set to the epoch, so
every acquire is an `UPDATE` and no code path needs an insert race.

`holder` is a per-process UUID generated at module init — the instance identity.

#### 9.3.3 Acquire, heartbeat, release

**Lock scope:** one job name. Per-job rows, not one shared row, so a slow
reconciliation pass cannot block order expiry — the two have unrelated failure
modes and very different durations.

**Connection and transaction ownership:** none required. Every operation is a
single statement through the ordinary pool. **This is the whole reason the lease
is used instead of an advisory lock** — correctness does not depend on which
connection served the call.

**Acquire** — the project's CAS idiom, one statement:

```ts
const { count } = await this.prisma.maintenanceLease.updateMany({
  where: { job, expiresAt: { lte: now } },     // free, or lapsed
  data:  { holder: this.instanceId, acquiredAt: now, heartbeatAt: now,
           expiresAt: new Date(now.getTime() + leaseMs) },
});
// count === 1 → acquired.   count === 0 → someone else holds a live lease.
```

The predicate travels with the write, exactly as in `markPaid`, `cancel`,
`decrementStock`, and `rotate`. Two instances racing produce one `count === 1`
and one `count === 0`.

**Heartbeat** — every `leaseMs / 3`, while the job runs:

```ts
const { count } = await this.prisma.maintenanceLease.updateMany({
  where: { job, holder: this.instanceId },
  data:  { heartbeatAt: now, expiresAt: new Date(now.getTime() + leaseMs) },
});
if (count === 0) { /* lease lost — abort the sweep immediately */ }
```

The `holder` predicate means an instance can only renew its *own* lease.

**Release** — in a `finally`, holder-scoped so a late release cannot free someone
else's lease:

```ts
await this.prisma.maintenanceLease.updateMany({
  where: { job, holder: this.instanceId },
  data:  { expiresAt: new Date(0) },
});
```

**Crash safety:** a process that dies holding a lease stops heartbeating; the
lease lapses after at most `leaseMs` and the next tick acquires it. No manual
intervention, and no stale lock that survives restart — the failure mode that
makes session-scoped advisory locks unsafe here.

#### 9.3.4 The fencing guarantee — why two instances cannot both act

A lease alone is not a hard guarantee: a process paused longer than `leaseMs` (GC,
container freeze) could resume believing it still holds one. Phase 5 therefore
does **not** rely on the lease for correctness. Two mechanisms stack:

**1. Fencing — the lease is re-asserted inside the same transaction as the
mutation.** Each per-order commit (§4.5) begins with:

```ts
const { count } = await tx.maintenanceLease.updateMany({
  where: { job, holder: this.instanceId, expiresAt: { gt: new Date() } },
  data:  { heartbeatAt: new Date() },
});
if (count === 0) throw new LeaseLostError();   // rolls the transaction back
```

Because the lease check and the state change are in **one** transaction, an
instance whose lease has been taken over **cannot commit an expiry**. This is a
genuine guarantee at the granularity where correctness lives, and it does not
require holding any lock across the provider call.

**2. The per-order CAS is independently sufficient against double restoration.**
Even if two sweeps overlapped completely, `updateMany({ where: { id, status:
PENDING } })` matches for exactly one of them, so stock is restored exactly once.

The honest division: **the lease prevents wasted duplicate work; the fencing
check and the CAS prevent incorrect work.** Correctness never depends on the
lease being perfectly exclusive.

#### 9.3.5 Lock acquisition failure

A tick that cannot acquire returns immediately with
`{ status: 'skipped', reason: 'lease-held' }` and logs at `warn`. It **never
waits** — the next scheduled tick is already the retry, and blocking would let
ticks pile up behind a slow run. Nothing is enqueued, because there is no queue.

For the admin trigger, the same failure surfaces as **409** (§10.1).

#### 9.3.6 Test strategy proving exclusion

1. **Unit:** acquire twice without releasing → second returns `count === 0`.
   Heartbeat after a foreign takeover → `count === 0`, sweep aborts.
2. **E2E, real PostgreSQL:** two `MaintenanceRunner` instances with **different
   `holder` ids** against the same database, `Promise.all` both `run('order-expiry')`
   on a fixture of expired orders. Assertions: exactly one reports `completed` and
   one `skipped: 'lease-held'`; total units restored equals the ordered quantity
   **once**; `assertStockConserved` passes.
3. **Fencing, directly:** start instance A's sweep, force-expire its lease and
   acquire it as instance B mid-run, then let A attempt its commit. Assert A's
   transaction **rolls back** (`LeaseLostError`) and the order remains `PENDING`
   with stock unrestored, so no half-applied state exists.
4. **Negative control C-E2 (§14.4):** remove the fencing re-assertion and the
   lease acquire, then run test 2. It must fail by restoring stock **twice**.

### 9.4 No queue, no retries, no dead-letter queue

There is no durable queue message, therefore **no poison-job class exists**. A
failed item is re-selected next tick against freshly read state; a permanently
failing one becomes a `PROVIDER_UNREACHABLE` or `PROVIDER_PAYMENT_NOT_FOUND`
finding rather than an infinite retry loop. This is the whole retry model, and it
is a direct consequence of D2.

### 9.5 Per-job failure behaviour

| Job | Item failure | Tick failure | Retry |
|-----|--------------|--------------|-------|
| `order-expiry` | Log, count in `failed`, continue to the next order. The failed order stays `PENDING`. | Release the lease in `finally`; log at `error`. | Next tick |
| `maintenance-purge` | A failed batch aborts that table's purge for this tick; the other table still runs. | As above | Next tick |
| `payment-reconciliation` | Per-candidate failures become findings (§8.3); never abort the tick. | As above | Next tick |

No job retries an item within a tick. Retrying immediately against the same
unavailable provider would multiply load during exactly the incident that caused
the failure.

---

## 10. Admin maintenance API

### 10.1 `POST /api/v1/admin/maintenance/:job/run`

**Security and dispatch are both closed sets.**

- **ADMIN only**, via a class-level `@Roles(Role.ADMIN)` on a dedicated
  controller — the Phase 2 structural pattern: all admin routes live on a
  controller carrying a single class-level `@Roles(Role.ADMIN)`. Asserts **401**
  anonymous and **403** for a customer in e2e.
- **`:job` is an allowlist enum, validated before dispatch.**

  ```ts
  export enum MaintenanceJobName {
    ORDER_EXPIRY = 'order-expiry',
    MAINTENANCE_PURGE = 'maintenance-purge',
    PAYMENT_RECONCILIATION = 'payment-reconciliation',
  }
  ```

  Validated by `@IsEnum(MaintenanceJobName)` on a param DTO. An unlisted value is
  a **400** from the global `ValidationPipe` and never reaches the runner. This
  mirrors Phase 2's sort-field rule: no free-form string selects code.

- **No dynamic dispatch.** The runner resolves the job through an explicit,
  exhaustively-typed map, never by method-name lookup:

  ```ts
  private readonly jobs: Record<MaintenanceJobName, () => Promise<JobCounts>> = {
    [MaintenanceJobName.ORDER_EXPIRY]: () => this.expiry.sweep(),
    [MaintenanceJobName.MAINTENANCE_PURGE]: () => this.purge.run(),
    [MaintenanceJobName.PAYMENT_RECONCILIATION]: () => this.reconciler.run(),
  };
  ```

  `Record<MaintenanceJobName, …>` makes a missing entry a compile error, so adding
  an enum member cannot silently produce an unroutable job. `this[name]()`-style
  lookup is **forbidden**: it would make any string that reached dispatch a method
  selector.

- **Takes the same lease** as the scheduled job of that name (§9.3). A caller
  arriving while a run is in flight receives **409** and starts nothing. This is
  what prevents an admin from launching twenty concurrent sweeps and exhausting
  the connection pool.
- `@Throttle({ default: { ttl: 60_000, limit: 5 } })`. The key **must** be
  `default` — the name `ThrottlerModule.forRoot` assigns when none is given; any
  other key is silently ignored.

### 10.2 Synchronous, and why that is correct here

The route **runs the job and returns its result**. It is not `202 Accepted`, and
it returns no job id.

- Phase 5 has **no queue** (D2), so there is nothing to enqueue onto and no
  worker to pick work up. A `202` would have to be backed by a fabricated
  in-memory job registry — an abstraction with one consumer, invented to describe
  work that is already finishing synchronously.
- The jobs are **bounded by construction**: every one processes at most its batch
  size per run, so the response time is bounded by configuration rather than by
  data volume.
- The lease already provides the property `202` would be used for — refusing
  concurrent runs — and refuses with a **409** that is immediate and honest.
- Tests and operators both want the outcome, not an id to poll.

Should a future phase introduce a broker, this route becomes the natural place to
switch to `202` with a job id. That is a deliberate future change, not an absence.

**Status codes:** `200` completed · `200` with `status: "skipped"` when the lease
is free but the job found nothing to do · `409` lease held · `400` unlisted job
name · `401` anonymous · `403` non-admin · `429` throttled.

### 10.3 Response — a safe summary only

```json
{
  "job": "order-expiry",
  "startedAt": "2026-10-07T12:00:00.000Z",
  "durationMs": 412,
  "status": "completed",
  "examined": 37,
  "affected": 12,
  "skipped": 25,
  "failed": 0
}
```

`status` is `completed` | `skipped`; when `skipped`, a `reason` of `lease-held` is
included. **No raw provider payloads, no `clientSecret`, no order, payment, or
customer identifiers, no finding details.** The counts are safe to surface; the
contents are not. An operator who needs detail uses §10.4, which is itself
ADMIN-only and DTO-mapped.

### 10.4 `GET /api/v1/admin/reconciliation/findings`

ADMIN only, same controller and class-level `@Roles(Role.ADMIN)`.

Paginated with the **existing** `PaginationQueryDto`, `PaginatedDto`, and
`@ApiPaginatedResponse` primitives — Phase 2 assessed these against real
consumers and recorded that they are not to be reshaped without new evidence.

- `kind` — optional, `@IsEnum(ReconciliationFindingKind)`
- `resolved` — optional boolean, **defaults to `false`** so an operator sees
  active findings by default (§8.5)

Returns `ReconciliationFindingResponseDto` with a static `from()` mapper, because
controllers never return Prisma objects directly. The DTO exposes `orderId`,
`paymentId`, `kind`, `occurrences`, `firstSeenAt`, `lastSeenAt`, `resolvedAt`, and
the sanitised `detail` — never a provider payload.

---

## 11. `GET /api/v1/orders/:id` — `expiresAt`

`OrderResponseDto` gains `expiresAt: string | null` (ISO-8601), mapped in
`from()`. It is **server-authoritative**: the stored column, never a value
recomputed from `createdAt` at read time, so the client and the sweep agree on
one deadline.

It is `null` for orders created before the migration, and for orders in a terminal
state where it is no longer meaningful. The list route gains it too — it is the
same mapper.

This is a deliberate product decision in the manner of Phase 3's D10
(`stockQuantity` on the public catalog): it exposes a server-side timer to the
client, and is accepted because a checkout countdown is useless without it and it
reveals nothing an owner cannot already infer from their own order.

---

## 12. Security

- **Every new route is ADMIN-only**, on a controller carrying a single class-level
  `@Roles(Role.ADMIN)`. Each asserts **403 for a non-admin** and **401 for
  anonymous** in e2e, per Phase 2's mitigation structure.
- **`:job` is an allowlist enum validated before dispatch, and dispatch is a
  typed `Record`, not a dynamic method lookup** (§10.1). No caller-supplied string
  can select code.
- **The trigger route is a thundering-herd lever**, so it takes the same lease and
  is rate-limited. Without the lease it would be the easiest way for an
  authenticated admin to exhaust the connection pool.
- **No new secret, and no new credential of any kind.** Phase 5 adds only numeric,
  boolean, and cron-expression configuration. Reconciliation reads the provider
  with the existing `PAYMENT_API_KEY`; it needs no new scope and must not request
  one.
- **Findings never store sensitive material** (§8.4). `detail` is a closed set of
  ids, amounts, currencies, and timestamps.
- **Never log a provider payload, a `clientSecret`, or a signature header** at any
  level. Phase 1's and Phase 4's logging rules extend unchanged to every new job.
- **Job summaries leak no customer data** (§10.3).
- `ReconciliationFinding.order` is `onDelete: Restrict`, so findings cannot be
  erased as a side effect of another deletion.
- `MaintenanceLease.holder` is an internal instance UUID and is never exposed by
  any route.

---

## 13. Observability and operational considerations

- **One structured log line per tick** — `log` for a completed run, `warn` for a
  skipped one: job name, lease outcome, examined / affected / skipped / failed,
  duration.
- **Error-level logs for every divergence**, preserving Phase 4's existing
  error-level divergence logging.
- **The alertable signal is
  `COUNT(*) FROM reconciliation_findings WHERE resolved_at IS NULL`**, grouped by
  `kind`. This is the first number in the project an operator can watch instead of
  reading logs, and it is the point of F6.
- `maintenance_leases` is directly inspectable: `job`, `holder`, `heartbeatAt`,
  `expiresAt` answer "is a sweep running, on which instance, and since when?"
  without a dashboard. This is a deliberate advantage over an advisory lock, whose
  holder is far harder to attribute.
- `expiredAt` makes every lapse individually auditable.
- **Graceful shutdown:** `enableShutdownHooks()` is already registered in
  `configureApp()`. A job must check a shutdown flag **between** per-order
  transactions and stop cleanly, then release its lease in `finally`. The CAS and
  the per-order transaction make an interrupted tick safe regardless — the next
  tick re-selects whatever was missed — and releasing the lease prevents a lapsed
  lease delaying the next instance by up to `leaseMs`.
- Phase 3's deliberate non-mappings stand: `P2028`, `P2034`, and the Phase 3
  `CHECK` constraints remain unmapped in `HttpExceptionFilter`. A logged 500 is the
  correct signal for a broken invariant, and a maintenance job must not convert one
  into a friendly 4xx.

---

## 14. Testing strategy

### 14.1 Unit tests

Mock `PrismaService` and `PaymentProvider`. Cover: tier-A and tier-B selection;
the tier-B age gate; pre-check veto on `succeeded`; fail-closed on provider error
and on not-found; `expire()`'s `count === 0` branch restoring nothing;
`markPaid()`'s new `'expired'` outcome; `cancel()`'s new 409 branch; lease
acquire/heartbeat/release CAS results; the fencing abort; purge cutoff
arithmetic; each finding kind's predicate; and the finding lifecycle's three
transitions including re-open preserving `occurrences` and `firstSeenAt`.

### 14.2 E2E tests

Real dockerized PostgreSQL via `createTestApp()`, state reset with
`truncateAll()`. Expiry releases exactly the ordered units; a `PAID` order is
never selected; an order with `expiresAt IS NULL` is never selected; purge
deletes only rows past the cutoff; admin routes return 401 anonymous, 403 for a
customer, 400 for an unlisted job name, 409 while the lease is held; findings
default to active-only; `GET /orders/:id` exposes `expiresAt`.

### 14.3 Concurrency tests

The Phase 4 harness pattern, mandatory here: `await app.listen(0)` in setup so
`Promise.all` issues real parallel HTTP; `createTestApp([], { throttleLimit: 0 })`
so the auth throttle is never in the loop; tokens minted directly via
`app.get(TokenService).signAccessToken(user)`, never through `/auth/login`; and
**every test asserts no response is a 5xx**.

Properties: expiry vs. cancel; expiry vs. webhook; two instances with distinct
holders (§9.3.6 test 2); the fencing rollback (§9.3.6 test 3); N concurrent admin
triggers.

### 14.4 Negative controls — required before any concurrency test ships

Phase 3's design spec governs: *"Concurrency tests ship only after a recorded
negative control fails against a naive implementation — a green concurrency run
alone is never evidence."* Each control must fail **on the assertion that names
the property**, not incidentally — not a crash, not a `TypeError`, not a `P2025` —
and the failing output must be recorded.

| Control | Naive implementation | Must fail with |
|---------|---------------------|----------------|
| C-E1 | `expire()` as read → check `status` → update | stock restored **twice** on expiry-vs-cancel |
| C-E2 | remove the lease acquire **and** the fencing re-assertion | two instances both restore (§9.3.6 test 4) |
| C-E3 | restoration loop outside the transition's transaction | a **partial** restoration persists after an induced mid-loop failure |
| C-E4 | pre-check moved inside the transaction | external I/O inside a transaction (also violates §5.5) |
| C-E5 | fail-open on provider error | a succeeded payment's order expired and its stock restored |
| C-P1 | purge without the cutoff predicate | live, unexpired rows deleted |
| C-R1 | finding `create` instead of `upsert` | duplicate rows for one `(orderId, kind)`; unique violation |
| C-R2 | omit candidate set 3 (open findings) | a finding stays `resolvedAt IS NULL` after its condition clears |

If a control does **not** reproduce its failure, the result is recorded as a
**null result** and the property is reported as unproven — as Phase 3 did for C3
and Phase 4 did for its sequential P1 control. A green run is never upgraded to
proof by assertion.

### 14.5 Failure injection

`FakePaymentProvider` gains `failNextRetrieve()`, `notFoundNextRetrieve()`, and
`markNextRetrieveSucceeded()`, matching its existing `failNextCreate` /
`mismatchNextCreateAmount` / `expireIdempotencyKeys` idiom. No network, no
credentials, no provider account in CI.

### 14.6 Deterministic time — no clock abstraction

Because `expiresAt` is **stored data** (§5.1), a test creates an already-expired
order by writing a past timestamp. No fake timers, no injected `Clock`, no new
seam. Tier-B's age gate is tested the same way, by backdating `Payment.createdAt`;
lease lapse by backdating `MaintenanceLease.expiresAt`. Factories insert through
the Prisma client, never `$executeRaw` — ids are `@default(uuid(7))` generated
client-side, and a raw insert gets none.

### 14.7 Harness constraints that stay

`maxWorkers: 1` stays. The e2e advisory lock stays and is **unrelated** to the
lease (§9.3.1); no new code takes `E2E_LOCK_KEY`. Only one `npm run test:e2e` may
hold the test database at a time. `MAINTENANCE_JOBS_ENABLED=false` in the e2e
environment prevents a background tick from racing a test's own assertions.

---

## 15. Migration, schema, and configuration

### 15.1 One migration

`prisma/migrations/<timestamp>_phase5_expiry_and_reconciliation/`

1. `ALTER TYPE "OrderStatus" ADD VALUE 'EXPIRED'` — the Phase 4 precedent.
   **Implementer note:** PostgreSQL will not permit a newly added enum value to be
   *used* in the same transaction that added it on older servers. Order the
   migration so the `ADD VALUE` commits before any statement referencing
   `'EXPIRED'`; no statement in this migration needs to.
2. `orders` += `expires_at TIMESTAMP NULL`, `expired_at TIMESTAMP NULL`
3. `CREATE INDEX` on `orders (status, expires_at)` — the sweep's exact predicate
4. `CREATE INDEX` on `refresh_tokens (expires_at)` — the deferred entry says to
   add it "at the same time", since no current query needs one
5. `CREATE INDEX` on `payment_events (created_at)` — likewise, the cutoff column
6. `CREATE TABLE reconciliation_findings` with `UNIQUE (order_id, kind)` and an
   index on `(kind, resolved_at)`
7. `CREATE TABLE maintenance_leases`, **seeded** with one row per job name
   (`order-expiry`, `maintenance-purge`, `payment-reconciliation`), each with
   `holder = ''` and `expires_at = 'epoch'` so every acquire is an `UPDATE`

**No backfill of `expires_at`.** It stays `NULL` for existing orders, which the
sweep excludes by predicate (§5.4). This is deliberate: a backfill would make
every historical `PENDING` order instantly eligible, which is the mass-release
hazard §5.1 exists to avoid.

No new `CHECK` constraints. Phase 3's four remain, and remain deliberately
unmapped to 4xx.

### 15.2 Configuration — all additive, all Joi-validated, every default justified

Added to `src/config/configuration.ts` under a new `maintenance` key, to
`src/config/env.validation.ts`, and to `.env.example` **in the same change** —
`.env.example` must stay in sync with every variable the app reads. `src/config/`
remains the only place that reads `process.env`.

| Variable | Default | Rationale |
|----------|---------|-----------|
| `MAINTENANCE_JOBS_ENABLED` | `true` | Master switch for the crons; the admin trigger keeps working when `false`. This is how the e2e suite stops a background tick racing a test's assertions (§14.7) — the knob exists for a concrete need, not for symmetry. |
| `ORDER_EXPIRY_CRON` | `0 */5 * * * *` | Every 5 minutes. The tier-A TTL is 30 minutes, so a 5-minute cadence bounds post-deadline stock holding to ≤ ⅙ of the TTL while costing one bounded query per tick. Finer buys nothing: the deadline is a policy, not a latency target. |
| `ORDER_EXPIRY_TTL_MINUTES` | `30` | §5.3, tier A — policy, sanity-checked against `JWT_ACCESS_TTL=15m`. |
| `ORDER_EXPIRY_PAYMENT_STARTED_TTL_HOURS` | `24` | §5.3, tier B — derived from the ≥24-hour provider key retention documented in the Phase 4 spec. |
| `ORDER_EXPIRY_BATCH_SIZE` | `100` | Each candidate costs one bounded transaction (`TX_TIMEOUT_MS = 10_000` per order, per §4.5) plus, for tier B, one provider round trip. 100 keeps a worst-case tick well under the 5-minute cadence while draining a backlog in a bounded number of ticks. A batch-wide transaction is explicitly not used (§4.5), so batch size does not extend any single transaction. |
| `MAINTENANCE_PURGE_CRON` | `0 0 3 * * *` | Once daily, off-peak. Retention is measured in days (30 and 90), so a sub-daily cadence would do identical work repeatedly for no change in outcome. |
| `REFRESH_TOKEN_RETENTION_DAYS` | `30` | §15.3. `JWT_REFRESH_TTL=7d`, so 30 days keeps ≈3 weeks of post-expiry reuse-detection evidence. Joi enforces `>= 7` so a misconfiguration can never delete live tokens. |
| `PAYMENT_EVENT_RETENTION_DAYS` | `90` | §15.3. This table is the webhook idempotency ledger; a deleted row makes a pre-cutoff replay newly processable. 90 days is far outside any plausible provider retry window. Joi enforces `>= 30`. |
| `MAINTENANCE_PURGE_BATCH_SIZE` | `1000` | Deletes are single-row-lock, index-predicated, and touch no other table, so they are far cheaper per row than an expiry. 1000 bounds the delete's transaction well inside `TX_TIMEOUT_MS` while making a large first purge complete in few ticks. |
| `RECONCILE_CRON` | `0 */15 * * * *` | Every 15 minutes, matching `RECONCILE_MIN_AGE_MINUTES`: a payment becomes a candidate and is examined within roughly one cadence of becoming eligible. Faster would re-examine the same unchanged rows. |
| `RECONCILE_MIN_AGE_MINUTES` | `15` | Must exceed `WEBHOOK_TOLERANCE_SECONDS = 300` (5 min) — the window in which a legitimate webhook is still accepted — so an in-flight payment is never reported as divergent. 15 minutes is 3× that, leaving room for provider retry delay. |
| `RECONCILE_LOOKBACK_DAYS` | `30` | Upper bound on candidate-set growth (§8.2). Anything older than 30 days already has a finding from when it was in range, and re-examining it forever would make every tick slower as the table ages. Deliberately ≥ `REFRESH_TOKEN_RETENTION_DAYS` is **not** required — the two are unrelated tables. |
| `RECONCILE_BATCH_SIZE` | `100` | One provider round trip per candidate dominates. 100 bounds a tick's external calls, and at a 15-minute cadence drains 400/hour — far above any plausible divergence rate for this system. |
| `RECONCILE_PRECHECK_FAILURE_THRESHOLD` | `3` | Three consecutive failures before raising `PROVIDER_UNREACHABLE`, so a single transient blip does not page anyone, while a genuine outage surfaces within ~45 minutes at the default cadence. |
| `MAINTENANCE_LEASE_SECONDS` | `300` | Two constraints fix this. **Lower bound:** it must exceed the gap between heartbeats with margin — the heartbeat renews every `MAINTENANCE_LEASE_SECONDS / 3` (100s), so a live run never lapses even if several renewals are delayed. **Upper bound:** a crashed instance's lease must lapse quickly enough that the backlog does not grow; at 300s it lapses within one `ORDER_EXPIRY_CRON` period, so the worst-case recovery is one lapsed lease plus one tick (≤10 minutes). A long tick never relies on this value, because the heartbeat extends the lease for as long as the run is alive. |
| `PAYMENT_PROVIDER_TIMEOUT_MS` | `10000` | **New, and grounded in a real gap:** `StripePaymentProvider` currently constructs `new Stripe(apiKey, { apiVersion })` with **no timeout**, so a hung provider call could hang a sweep indefinitely. Passed as the SDK's `timeout`. 10s matches the project's own `TX_TIMEOUT_MS = 10_000`, the existing precedent for "longest a single operation may take". A timeout is indistinguishable from an outage to the caller and routes to the same fail-closed branch, so no separate knob is added to the port — consistent with `FakePaymentProvider`'s documented decision to have one failure mechanism. |

### 15.3 Purge semantics and retention cutoffs

- **`refresh_tokens`:** delete where `expires_at < now() - REFRESH_TOKEN_RETENTION_DAYS`.
  The cutoff is on **expiry**, not creation, so a long-lived valid token is never
  deleted. Revoked-but-unexpired rows are retained until their own expiry passes
  the cutoff, because they are **reuse-detection evidence**: Phase 1 revokes an
  entire family on replay, and deleting the row early would turn a detectable
  replay into an unknown token.
- **`payment_events`:** delete where `created_at < now() - PAYMENT_EVENT_RETENTION_DAYS`.
  This table is the **idempotency ledger** for webhook dedupe, and deleting a row
  makes a replayed delivery from before the cutoff newly processable. After the
  cutoff the row's only purpose is audit.
- Both delete in bounded batches (`MAINTENANCE_PURGE_BATCH_SIZE`), oldest first,
  and both are idempotent by predicate — re-running deletes nothing extra.
- **Retention is an invariant the purge may not violate.** Joi enforces
  `REFRESH_TOKEN_RETENTION_DAYS >= 7` (≥ `JWT_REFRESH_TTL`) and
  `PAYMENT_EVENT_RETENTION_DAYS >= 30`.
- `reconciliation_findings` and `maintenance_leases` are **not** purged. See
  §16.2.

---

## 16. Decisions and deferrals

### 16.1 Locked — not to be reopened

- `EXPIRED` as a new enum member (D1)
- Redis / BullMQ / Redis-backed throttling / caching deferred; documentation
  amended (D2)
- The provider read is a veto, never an authority (D3)
- Provider unavailable or not-found → fail closed (D4, §6.3)
- Reconciliation reports only; never mutates domain state (D5)
- Mutual exclusion is a transactional lease row with in-transaction fencing, not a
  PostgreSQL advisory lock (D6, §9.3)
- Every finding class is detectable from the local side with the existing
  retrieval-based port (D7, §8.3)
- Expiry transition, `expiredAt`, lease fencing, and **all** item restorations
  commit in one transaction per order; partial restoration is impossible (§4.5)
- The admin trigger is synchronous, allowlist-dispatched, and lease-guarded
  (§10.1, §10.2)

### 16.2 Non-blocking deferred decisions

None of these blocks implementation; each is recorded so it is not mistaken for
an oversight.

1. **Tier-A's 30 minutes is policy, not derivation** (§5.3). If a real inventory
   policy exists it supersedes this value; only the config default changes.
2. **`MAINTENANCE_JOBS_ENABLED` production default.** Whether a first deploy
   should start with crons off until an operator opts in is a deployment question.
   **Owner: Phase 6.**
3. **Findings and lease retention.** `reconciliation_findings` has no purge, so
   Phase 5 creates one new table that grows without bound. It is bounded in
   practice by `UNIQUE (orderId, kind)` — it grows with *distinct divergences*,
   not observations — so it is accepted. `maintenance_leases` is fixed-size (one
   row per job) and never grows. Task 7 records the findings table as a new
   deferred limitation.
4. **Provider-side orphan discovery** (§8.6). Requires a fifth port capability
   that nothing in the repository justifies today. Task 7 records it as a deferred
   limitation naming the capability.
5. **Multi-instance throttler state.** Still in-memory per instance. Unrelated to
   the lease, and **Owner: Phase 6** (deployment topology) together with the
   trusted-proxy decision.

### 16.3 Implementation risks

1. **Enum-value addition ordering** (§15.1). Verify by running the migration from
   scratch against the project's PostgreSQL 16.
2. **Provider status mapping** (§7.4). Must be written from provider
   documentation, not inferred. If it cannot be verified at implementation time,
   map conservatively to `'pending'` — the fail-closed direction — and record the
   gap.

The advisory-lock connection-affinity risk that previously sat here is **resolved
by D6**: the lease needs no connection affinity, so the risk no longer exists.

---

## 17. Task boundaries and dependencies

| # | Task | Deliverable | Depends on |
|---|------|-------------|------------|
| 1 | **Schema, config, and the lease** | The migration (§15.1), all configuration (§15.2), `@nestjs/schedule` wired, `MaintenanceLease` with acquire/heartbeat/release/fencing, and the exclusion tests of §9.3.6 (1, 2, 4) proving two holders cannot both act. | — |
| 2 | **`EXPIRED` and the lifecycle decision** | The enum member consumed: `markPaid()`'s new arm, `MarkPaidOutcome`, `cancel()`'s 409 branch, DTOs, and `assertStockConserved` updated for the new terminal state. Its own commit because it is the compile-tripwire task. | 1 |
| 3 | **Provider-contract extension** | `ProviderPaymentStatus`, the `status` field, not-found classification (§7.3), `PAYMENT_PROVIDER_TIMEOUT_MS` in the Stripe adapter, and the fake's three new test controls. | 1 |
| 4 | **Order expiry sweep** | Two-phase algorithm, tier gate, pre-check outside the transaction, fail-closed behaviour, and the atomic per-order commit of §4.5 reusing `incrementStock`. Includes the fencing-rollback test (§9.3.6 test 3). | 2, 3 |
| 5 | **Purge jobs** | Both tables, cutoff-predicated, batched, with the Joi retention floors (§15.3). | 1 |
| 6 | **Reconciliation and admin API** | All three candidate sets, all six finding kinds, the three-transition lifecycle, both admin routes with the allowlist enum and typed dispatch, Swagger, and `expiresAt` on the order DTOs. | 3, 4 |
| 7 | **Concurrency suite, negative controls, documentation** | Every control in §14.4 recorded failing first; `deferred-limitations.md`, `CLAUDE.md`, and `README.md` amended per D2; the findings-retention and provider-orphan limitations added. | all |

Task 2 is deliberately separate from Task 4: adding the enum member breaks the
build until every consumer decides what `EXPIRED` means, and that decision
deserves its own reviewer rather than arriving inside a larger feature commit.

Task 1 carries the lease-exclusion proof because every later task's correctness
argument depends on it; discovering a lease problem in Task 4 would invalidate
Task 4's own tests.

---

## 18. Acceptance criteria / Definition of Done

1. One migration adds `OrderStatus.EXPIRED`, `orders.expires_at`,
   `orders.expired_at`, the three new indexes, `reconciliation_findings` with
   `UNIQUE (order_id, kind)`, and `maintenance_leases` seeded with one row per job;
   verified by running it from an empty database.
2. `CheckoutService` writes `expires_at = now + ORDER_EXPIRY_TTL_MINUTES` on every
   new order.
3. The expiry sweep releases stock for a tier-A order past its deadline, restoring
   **exactly** the ordered units, asserted with `assertStockConserved`.
4. **A partial stock restoration is impossible:** an induced failure midway
   through a multi-item order's restoration leaves the order `PENDING` with **no**
   units restored (control C-E3 recorded failing without the shared transaction).
5. A tier-B order is **not** expired before its 24-hour gate, **not** expired when
   the provider reports `succeeded`, **not** expired when the provider read fails,
   and **not** expired when the provider does not recognise the id.
6. A tier-B order whose provider read fails repeatedly becomes a
   `PROVIDER_UNREACHABLE` finding at the configured threshold.
7. **No code in `src/` writes `OrderStatus.PAID` except `markPaid()`**, and
   `PaymentWebhookService` remains its only caller — verified structurally, as in
   Phase 4.
8. `markPaid()` returns `'expired'` for an expired order, logs at error level,
   mutates nothing, and the webhook returns **200**. No `default` arm was added to
   the `switch`.
9. `cancel()` returns **409** for an expired order and restores no stock.
10. Expiry racing cancel restores stock **exactly once**.
11. Expiry racing the webhook yields exactly one terminal state and no 5xx.
12. **Two runner instances with distinct holders cannot both act:** one reports
    `completed`, one `skipped: 'lease-held'`, and stock is restored exactly once.
13. **Fencing holds:** an instance whose lease is taken over mid-run cannot commit
    — its transaction rolls back and the order stays `PENDING` with stock
    unrestored.
14. **No provider call occurs inside any Prisma transaction**, verified by a
    structural test, not by inspection.
15. **No code takes `E2E_LOCK_KEY`**, and no code uses `pg_advisory_lock` or
    `pg_try_advisory_xact_lock` for a maintenance job — verified by grep.
16. Purge deletes only rows past the cutoff; a live refresh token is never
    deleted; Joi rejects `REFRESH_TOKEN_RETENTION_DAYS < 7` and
    `PAYMENT_EVENT_RETENTION_DAYS < 30`.
17. Reconciliation produces **one** finding row per `(orderId, kind)` regardless of
    how many passes observe it; `occurrences` and `lastSeenAt` advance;
    `firstSeenAt` never changes.
18. A finding whose condition clears gets `resolvedAt` set; a finding that recurs
    is **re-opened on the same row** with `occurrences` continuing and
    `firstSeenAt` preserved.
19. Reconciliation mutates no `orders`, `payments`, or `products` row — verified
    structurally.
20. Every finding kind is reachable in tests using only `retrievePayment()`; no
    provider-listing capability was added.
21. `POST /admin/maintenance/:job/run` is **401** anonymous, **403** for a
    customer, **400** for an unlisted job name, **409** while the lease is held,
    and **429** when throttled. Dispatch is a typed `Record`, not a dynamic method
    lookup — verified by grep for `this[`.
22. Job summaries contain no provider payload, `clientSecret`, or order, payment,
    or customer identifier.
23. `GET /admin/reconciliation/findings` defaults to active findings only.
24. `GET /orders/:id` returns server-authoritative `expiresAt`.
25. Every new route carries `@ApiTags`, `@ApiOperation`, and `@ApiResponse`, and
    the OpenAPI route-inventory assertion is extended to cover the new routes.
26. **Every negative control in §14.4 is recorded failing on its own assertion**
    against a naive implementation, or explicitly recorded as a null result.
27. `npm run lint:ci`, `npm run build`, `npm test`, and `npm run test:e2e` all
    green, with the Phase 4 baselines (325 unit / 249 e2e) **increased**, never
    reduced.
28. **No Redis, no BullMQ, no caching, no queue, and exactly one new runtime
    dependency (`@nestjs/schedule`).** Amended during implementation: `cron` is
    also **declared** in `package.json`, pinned to `4.4.0` — the exact version
    `@nestjs/schedule` itself pins. This adds **zero** packages to
    `node_modules`, which is what this criterion exists to prevent.
    `SchedulerRegistry.addCronJob()` is typed in terms of `CronJob` and
    `@nestjs/schedule` does not re-export it, so the import is unavoidable once
    the schedule is config-driven rather than decorator-driven (§9.2); leaving
    it undeclared was the real defect, because a transitive dependency swapping
    its cron implementation would break the import silently.
29. `README.md` and `CLAUDE.md` no longer describe Redis/BullMQ as Phase 5; the
    four closed deferred entries are closed **by shipping**, not by deletion; and
    the findings-retention and provider-orphan limitations are added.
30. No refunds, no reconciliation remediation, no confirm-payment route, and no
    change to Phase 4 payment authority.
