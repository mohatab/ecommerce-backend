# Phase 4 — Payments and Webhooks Design Spec

**Date:** 2026-09-23
**Status:** Draft for review — no implementation has started.
**Base:** `master` @ `3748c0d` (Phase 3 merged via PR #7, CI green — unit 192/192, e2e 175/175, Docker green, compiled admin bootstrap green, zero `40P01`, zero `P2028`)
**Owns:** `Payment`, `PaymentEvent`, `PaymentStatus`, `OrderStatus.PAID`, `PaymentsModule`, `PaymentProvider` and its two adapters

---

## 1. Purpose and scope

Phase 3 was the correctness phase: it proved stock cannot be oversold. Phase 4 is
the **trust-boundary phase**. Phases 1–3 answered *who is the caller*, *what may
they do*, and *what happens under contention*. Phase 4 answers a harder question:
*what is authoritative when a third party we do not control tells us money moved,
possibly twice, possibly late, possibly about an order that no longer wants it?*

The deliverable that matters is not the endpoint count. It is that the
`PENDING → PAID` transition happens **exactly once** per order under duplicate,
concurrent, late, out-of-order and forged webhook delivery — proven by tests that
fail against plausible naive implementations.

### In scope

1. `OrderStatus.PAID` as an additive enum value.
2. `Payment` and `PaymentEvent` models, plus `PaymentStatus`.
3. A `PaymentProvider` port with two real, DI-selected adapters: `StripePaymentProvider` and `FakePaymentProvider`.
4. `POST /api/v1/orders/:id/payments` — owner-scoped payment initiation, idempotent across the provider's key-retention window **and beyond it**.
5. `POST /api/v1/payments/webhook` — signature-verified, the **sole** authority for `PENDING → PAID`.
6. Raw-body support configured through a single shared application-options seam.
7. A concurrency e2e suite (P1–P4), each test paired with a recorded negative control.
8. Unit coverage of every branch in the new services and both adapters.
9. Documentation updates: `CLAUDE.md`, `README.md`, `.env.example`, `docs/deferred-limitations.md`.

### Out of scope

**Phase 5 owns:** Redis, BullMQ, any scheduled or background job, `PENDING`-order
expiry, automatic stock release, `payment_events` purge, automated reconciliation
sweeps. **None of it may leak into Phase 4** (§16 argues why Phase 4 needs none
of it).

**Phase 6 owns:** observability, structured logging, trusted-proxy configuration,
deployment.

**Deliberately excluded from Phase 4, additive later:** refunds, partial refunds,
disputes and chargebacks, provider-side intent cancellation, saved payment
methods, subscriptions, receipts and email, admin payment routes, reconciliation
reports, multi-provider operation, multi-currency conversion, `PaymentStatus.FAILED`
or `REFUNDED`, and any order status beyond `PENDING`/`CANCELLED`/`PAID`.

**Excluded by D11, and not merely unbuilt — actively refused (§7.5):** a
demo-only confirm-payment endpoint, a `confirmPayment` provider method, a browser
frontend, and any route whose sole purpose is to make the demo easier. Payment
*completion* is out-of-band, performed with provider test tooling.

**Permanently excluded by the foundation spec:** reviews, wishlists, coupons,
shipping-provider integration, multi-vendor.

**Explicitly forbidden:** a plugin registry, a generic payment framework, provider
methods with no caller, or any abstraction not justified by two existing
implementations.

### The one promise this spec refuses to make

> **Not every `PENDING` order can be paid.**

Phase 3's order-total ceiling is `MAX_TOTAL_CENTS = 2_147_483_647`
(`src/modules/orders/checkout.service.ts:14`). No payment provider accepts that
range. §5.4 defines the exact behaviour, and §17 records it as a limitation.
Any wording in any document that implies universal payability is wrong.

---

## 2. Conflicts found before design

Surfaced rather than silently resolved, in the style of the Phase 2 and Phase 3
specs. Each has a resolution that ships.

### C1 — webhook dedupe vs. "Prisma errors are never caught"

The textbook webhook dedupe is `try { create(eventId) } catch (P2002) { return 200 }`.
`CLAUDE.md` forbids it outright: *"Prisma errors are never caught in a service or
controller."* Letting `P2002` escape is worse — `HttpExceptionFilter` maps it to
**409**, the provider reads that as failure, and retries the same event forever.

**Resolution.** `createMany({ data: [...], skipDuplicates: true })`, which Prisma
compiles to `INSERT … ON CONFLICT DO NOTHING` on PostgreSQL and returns `{ count }`.
`count === 0` means *already delivered*. No exception is raised, nothing is
caught, and the predicate travels with the write — **the same idiom as
`ProductsService.decrementStock()`, one table over.** The rule is honoured, not
excepted.

### C2 — `rawBody` is a `NestFactory` option, but `configureApp()` is the config seam

`CLAUDE.md`: *"All application-level configuration … lives in `configureApp()` in
`src/bootstrap.ts`, so runtime and e2e tests are configured identically."*
`rawBody` is not application-level configuration — it is a **construction**
option, consumed by two different factories:

- `src/main.ts:9` — `NestFactory.create(AppModule)`
- `test/helpers/create-test-app.ts:41` — `moduleFixture.createNestApplication<…>()`

Passing `{ rawBody: true }` at both call sites by hand is exactly the divergence
`configureApp()` exists to prevent: a test app whose webhook verification silently
cannot work, or a runtime app whose webhook silently cannot work, with the other
half green.

**Resolution (§5.2).** `src/bootstrap.ts` exports one `NEST_APP_OPTIONS`
constant. Both factories pass it. `configureApp()` remains untouched as the
configuration seam. One definition, two consumers, zero duplicated values.
**No route-local body-parser middleware** — rejected explicitly.

### C3 — a deterministic provider idempotency key is **not** a permanent guarantee

The brainstorm proposed deriving the provider idempotency key from `order.id`, so
"same order → same intent forever". **That is false.** Stripe retains idempotency
keys for a bounded window (documented as at least 24 hours); once pruned, the same
key produces a **new** PaymentIntent.

The consequence is not merely a weakened guarantee — it is a **correctness bug**
in the brainstorm's flow. After retention expiry, a replayed initiation would
create a second intent, the local `createMany({ skipDuplicates: true })` would
no-op on the existing `@@unique([orderId])` row, and the API would hand the client
a `clientSecret` belonging to an intent whose id **is not the one persisted**. The
webhook would then be reconciling a different object than the one the customer is
paying.

**Resolution (§7).** The **local `Payment` row is the durable guarantee; the
provider key is only a concurrency optimisation inside its own retention window.**
Once a `Payment` row exists, `createPayment` is never called again — the service
calls `retrievePayment(providerPaymentId)`, which is a lookup by id and has no
retention limit. The provider interface therefore gains a third method. §7.4 walks
every case the correction demands.

### C4 — Stripe's amount range is far narrower than Phase 3's order ceiling

`MAX_TOTAL_CENTS` is `2_147_483_647` (the `INT` bound). A PaymentIntent's amount
range is much smaller at the top, and — easy to miss — has a **minimum** too:
`Product.priceCents` is only constrained to `>= 0`
(`order_items_unit_price_non_negative`), so a 0-cent or 1-cent order is a valid
Phase 3 order and an invalid payment.

**Resolution (§5.4).** A pure, non-I/O `amountLimits(currency)` capability on the
port; validation **before** the provider call; **422** when out of range;
identical enforcement in the fake so the boundary is deterministically testable.
**Phase 3 checkout is not changed** — §5.4 proves Phase 4 stays correct without
touching it.

### C5 — the webhook is unauthenticated, and the throttler was tuned for authenticated traffic

`AppModule`'s global limit is 100/min **per handler per IP**
(`src/app.module.ts`). Every delivery from one provider arrives from a small,
shared IP set, so a legitimate burst self-throttles. But `@SkipThrottle()` would
leave an unauthenticated endpoint that performs HMAC **and** database work with no
protection at all.

**Resolution (D8, §12).** An explicit raised `@Throttle({ default: { … limit: 300 } })`.
Key `default` — `CLAUDE.md` records that any other key is ignored **silently**.
This sits inside the blast radius of the open trusted-proxy limitation
(`docs/deferred-limitations.md`), which is cross-referenced, **not** fixed here.

### C6 — `PaymentsModule` would otherwise write the `orders` table

Phase 3 established one owning module per table (`ProductsService.describeRefusal()`
stays in `ProductsService` because it reads the products table). A
`PENDING → PAID` CAS issued from `PaymentsModule` would put `orders` writes in two
modules.

**Resolution (D9, §9.3).** `OrdersModule` exports `OrdersService`, which gains one
method — `markPaid(tx, orderId)` — taking `tx` as a **required** parameter, the
same convention as `decrementStock(tx, …)`. `PaymentsModule` imports
`OrdersModule`. The `orders` table keeps exactly one owning module.

### C7 — `@Public()` on a money endpoint, next to a money endpoint that must never be public

`JwtAuthGuard` is global and fails closed, so the webhook **must** carry
`@Public()` — the provider has no bearer token. That decorator then lives one
careless copy-paste away from the initiation route.

**Resolution (§9.1).** Two controllers, not one, mirroring why
`admin-products.controller.ts` is split from `products.controller.ts`: **one trust
posture per controller class.** The webhook controller is entirely `@Public()`;
the initiation controller is entirely bearer-authenticated. An e2e test asserts
the initiation route returns 401 without a token.

### C8 — currency case mismatch at the provider boundary

`Product.currency` / `Order.currency` are uppercase ISO-4217 (Phase 2 enforces
`@IsUppercase()`). Stripe uses lowercase codes. A naive
`event.currency !== order.currency` comparison fails on **every** event — a
total-outage-class bug that no unit test with hand-written fixtures would catch
unless it used real casing.

**Resolution (§8.4).** Normalisation happens **only** in the adapter: lowercase
outbound, uppercase inbound. The domain never sees a lowercase currency, and the
webhook comparison is a plain `===` on uppercase values. An adapter unit test
asserts both directions.

---

## 3. Decisions at a glance

**Approved in review (D1–D11).** These were decided by the project owner and are not re-opened by this spec.

| # | Decision | Choice | Key reason |
|---|---|---|---|
| **D1** | Payment persistence shape | Dedicated `Payment` model, 1:1 with `Order` | Roadmap §9 allocates it; keeps provider identifiers off the row `OrderResponseDto` maps; gives the webhook a second independent CAS target |
| **D2** | `PaymentStatus` values | `PENDING`, `SUCCEEDED` only | No writer exists for `FAILED`/`REFUNDED` in Phase 4 (D4 ships one event type; refunds are out of scope) |
| **D3** | Raw body | `NestFactory`/`createNestApplication` option `rawBody: true`, supplied by a shared `NEST_APP_OPTIONS` const | Nest's supported mechanism; the shared const keeps runtime and e2e identical without route-local parser hacks |
| **D4** | Supported webhook events | `payment_intent.succeeded` only | The only event that changes authoritative local state; one terminal transition = minimum ordering surface |
| **D5** | Cancel during in-flight payment | **Not** blocked | Preserves Phase 3's `status: PENDING` CAS untouched; blocking would make an abandoned payment form permanently un-cancellable and its stock unreleasable |
| **D6** | Webhook route | `POST /api/v1/payments/webhook` | Provider-neutral; the port abstracts the format |
| **D7** | Env var names | `PAYMENT_PROVIDER`, `PAYMENT_API_KEY`, `PAYMENT_WEBHOOK_SECRET` | Provider-neutral, matching the port. Production rejects `fake` at boot |
| **D8** | Webhook throttling | Explicit `@Throttle({ default: { ttl: 60_000, limit: 300 } })` | Raised, not skipped — see C5 |
| **D9** | `orders` write ownership | `OrdersModule` exports `OrdersService.markPaid(tx, …)` | One owning module per table (Phase 3 convention) |
| **D10** | Stripe API version | Pinned to `2026-08-26.dahlia` with `stripe@22.6.2` | Verified: the SDK types `apiVersion?: LatestApiVersion`, so the pin is compiler-enforced against the installed SDK (§6.3) |
| **D11** | How payment is completed in the demo | **Out-of-band, through provider test tooling** (Stripe CLI / test-mode dashboard or equivalent). The backend's contract ends at returning the `clientSecret` | The project has no browser frontend (foundation spec: *"Client: Swagger/HTTP only"*). A demo-only confirm endpoint would add a route and a provider method whose only purpose is convenience, and would put a *second* writer next to the webhook on the paid path. §7.5 |

**Derived by this spec (S1–S5).** Consequences of the approved decisions plus the conflicts in §2. Each is resolved here, not left open.

| # | Decision | Choice | Key reason |
|---|---|---|---|
| **S1** | Idempotency guarantee source | The **local `Payment` row**, not the provider key | Provider key retention is bounded (C3); a row lookup is not |
| **S2** | Provider interface size | 3 I/O methods + 1 pure capability | Each has exactly one caller in Phase 4; nothing speculative |
| **S3** | Unpayable order totals | **422** before any provider call | Coherent request, unprocessable order — matches Phase 3 §6.5's 409/422 split |
| **S4** | Client secret persistence | **Never persisted** | Avoids storing a credential at rest; `retrievePayment` supplies it on replay |
| **S5** | Webhook order resolution | Signed `metadata.orderId`, not a `providerPaymentId` lookup | Makes the webhook independent of initiation having committed (§15, P4) |

---

## 4. Payment lifecycle and state machine

### 4.1 `OrderStatus`

```
                  checkout (Phase 3, unchanged)
                            │
                            ▼
                      ┌──────────┐
      cancel ◄────────│ PENDING  │────────► PAID      webhook: payment_intent.succeeded
  (Phase 3 CAS,       └──────────┘            │
   unchanged)               │                 ✕ no transition out of PAID in Phase 4
            │               │
            ▼               ▼
      ┌───────────┐   (no other edges exist)
      │ CANCELLED │  ✕ no transition out of CANCELLED in Phase 4
      └───────────┘
```

**Three values, total. No new statuses.** `AWAITING_PAYMENT` / `PAYMENT_PENDING`
were considered and rejected: an in-flight attempt does not change what the order
*is* — it is still an unpaid order holding stock, which is exactly `PENDING`. An
attempt is a fact about the **payment**, and lives on the payment row. A fourth
status would also force Phase 5's expiry job to carry a second predicate.

### 4.2 `PaymentStatus`

```
PENDING ──► SUCCEEDED        (terminal; no edge out, no FAILED, no REFUNDED)
```

### 4.3 The full interaction matrix (D5)

| Order state | Event | Result |
|---|---|---|
| `PENDING` | cancel | **Unchanged Phase 3 behaviour.** CAS matches, stock restored exactly once, **200** |
| `PENDING` | payment initiation | Intent created or replayed, **201**/**200**. Order stays `PENDING` |
| `PENDING` | webhook success | CAS matches → **PAID**. Stock stays decremented (it is sold) |
| `PAID` | cancel | **409.** Stock is **not** restored |
| `PAID` | payment initiation | **409** "Order is already paid" |
| `PAID` | duplicate webhook success | **200**, no state change |
| `CANCELLED` | payment initiation | **409** "Order is cancelled" |
| `CANCELLED` | **late webhook success** | Order stays **CANCELLED**; `Payment` → **SUCCEEDED**; error-level log; **200** to the provider. **The money is not returned in Phase 4** (§17.1) |

**`PAID → CANCELLED` is refused** because cancelling would restore stock for goods
that were paid for and would owe a refund. **`CANCELLED → PAID` is refused**
because stock has already been restored and possibly resold; flipping would break
the stock-conservation invariant Phase 3 proved.

**Phase 3 code change required, and it is the only one:** `OrdersService.cancel()`
currently treats every CAS miss as idempotent and returns the order with **200**.
Phase 4 must split that branch — `CANCELLED` → 200 (unchanged), `PAID` → **409**.
The CAS predicate itself (`status: PENDING`) is **not** touched, so exactly-once
cancellation is preserved by construction.

---

## 5. Cross-cutting mechanics

### 5.1 Why raw body is required

Webhook authenticity is an HMAC over the **exact bytes the provider sent**.
Express's JSON parser produces a JavaScript object; re-serialising it with
`JSON.stringify` does not reproduce those bytes — key order, whitespace, and
unicode escaping all differ. Verifying against a re-serialised body fails for every
authentic event, and "fixing" it by skipping verification would make the endpoint
an unauthenticated writer of paid state. **Raw bytes are not an optimisation; they
are the entire security property.**

### 5.2 Where `rawBody: true` is configured (D3, resolves C2)

`src/bootstrap.ts` gains one exported constant beside `configureApp()`:

```
NEST_APP_OPTIONS: NestApplicationOptions = { rawBody: true }
```

- `src/main.ts` → `NestFactory.create(AppModule, NEST_APP_OPTIONS)`
- `test/helpers/create-test-app.ts` → `moduleFixture.createNestApplication<…>(NEST_APP_OPTIONS)`

Both factories accept `NestApplicationOptions`; the value is defined **once** and
imported twice. `configureApp(app)` is unchanged and remains the single seam for
*configuration* (helmet, CORS, prefix, versioning, pipes, filters, shutdown
hooks); `NEST_APP_OPTIONS` is the single seam for *construction*. The two seams
live in the same file so the pairing is impossible to miss.

**Rejected alternatives**

| Alternative | Why rejected |
|---|---|
| `app.use('/api/v1/payments/webhook', express.raw(…))` inside `configureApp()` | A route-local body-parser hack, explicitly ruled out. It also hardcodes a path string in the bootstrap layer and bypasses Nest's supported mechanism |
| `{ rawBody: true }` written literally at both call sites | Exactly the duplication C2 describes: one site can be edited without the other, and the failure is silent on whichever side is not tested |
| Raw body for the whole app with a custom parser | Breaks every other route's DTO validation |

**How runtime and e2e stay identical:** they import the same constant from the same
module. Divergence now requires deleting an import, which fails the raw-body
regression e2e (§15.2) because `createTestApp` produces an app whose webhook
cannot verify anything.

### 5.3 How the webhook reads the raw body

The controller takes `@Req() request: RawBodyRequest<Request>` (Nest's own type)
and reads `request.rawBody` — a `Buffer`. The parsed `request.body` is **never**
used for verification.

`rawBody` is `Buffer | undefined`. If it is `undefined`, the application was
constructed without the option, and the handler **must throw**, producing a logged
500 — never fall back to an empty buffer, never verify against `''`, never skip
verification. A misconfiguration that silently disabled signature checking on a
money endpoint is the single worst outcome available in this phase, so it is made
loud by construction.

### 5.4 Payable amount range (resolves C4)

**The port exposes a pure capability, not an I/O method:**

```
amountLimits(currency: string): { minMinorUnits: number; maxMinorUnits: number } | null
```

`null` means *this provider cannot take money in that currency*.

**Validation happens in `PaymentsService`, before any provider call:**

| Condition | Response |
|---|---|
| `amountLimits(order.currency) === null` | **422** `Currency is not supported for payment` |
| `order.totalCents < minMinorUnits` | **422** `Order total is outside the payable range` |
| `order.totalCents > maxMinorUnits` | **422** `Order total is outside the payable range` |

**422, not 409**, per Phase 3 §6.5: *409 means the state of the world refuses this;
422 means this request is coherent but unprocessable.* The order is real, owned by
the caller, and `PENDING` — nothing about the world refuses it. It is the amount
that cannot be processed. This is the direct analogue of Phase 3's own
`Order total exceeds the supported maximum` → 422.

**The limits are a domain contract, not an adapter detail.** They live in one
exported constant in `provider/payment-provider.ts` and both adapters return from
it, so the fake enforces byte-identical behaviour and the boundary is
deterministically testable with no network. If a future provider ever has
different limits, the port gains per-adapter limits *at that time* — not
speculatively now.

**Rule for choosing the numbers:** the constant must be **at or inside** the real
provider's published range, never wider. A conservative constant produces a clean
422; a too-wide constant produces an opaque provider rejection.

#### 5.4.1 Verified values (Stripe, confirmed 2026-09-23)

Source: **Stripe — *Supported currencies*, §"Minimum and maximum charge amounts"**,
`https://docs.stripe.com/currencies`. Read directly, not recalled.

| Quantity | Documented value | Exact wording |
|---|---|---|
| Minimum, USD | **`50`** minor units | *"Use these minimum amounts by currency: 0.50 USD …"* |
| Maximum, most card networks | 12 digits — `999_999_999_999` | *"12 digits for most card payments, for a maximum of 999,999,999,999 in minor units"* |
| Maximum, American Express | 9 digits — `999_999_999` | *"9 digits for American Express in most currencies, for a maximum of 999,999,999 in minor units"* |
| Maximum, non-card methods, most currencies | 8 digits — **`99_999_999`** | *"8 digits for all other currencies, for a maximum charge of 999,999.99 (99999999)"* |

**Locked Phase 4 contract:** `USD → { minMinorUnits: 50, maxMinorUnits: 99_999_999 }`;
every other currency → `null`.

**Why the maximum is the *lowest* documented tier, not the highest.** There is **no
single documented maximum** — it depends on the payment method the customer chooses
(card network vs. Amex vs. non-card), and Stripe further states that *"Card networks
can impose charge amount limits that are more restrictive than digit number,
depending on currency and region"* and that *"Some payment methods enforce their own
per-currency maximums that can be more restrictive."* The backend does not know, at
initiation time, which method the customer will use. Choosing `99_999_999` — the
8-digit tier — is the only value below **every** documented tier, so a 422 is
correct for every method rather than for some of them.

**Two honest consequences, stated rather than buried:**

- **A value inside our range can still be refused by the provider** for method,
  network or region reasons that are documented as existing but not enumerable
  in advance. That path is already handled: the provider call fails and §9.5
  returns **502**. The `amountLimits` check narrows the failure surface; it does
  not eliminate it, and this spec does not claim otherwise.
- **The minimum is settlement-dependent.** Stripe: *"The minimum amount you can
  charge depends on the payout bank account settlement currency."* `50` is correct
  for a USD-settling account, which is the only configuration this project
  documents. A deployment settling in another currency must revisit the constant.

**The design still does not depend on these numbers.** They are one exported
constant; correcting them is a one-line change plus a fixture update. What the
design depends on is the *contract shape* — a pure capability consulted before any
provider call — and that is what tests I1/A1 protect.

**C4 confirmed by documentation, not by assumption:** Phase 3's
`MAX_TOTAL_CENTS = 2_147_483_647` is a 10-digit value. It exceeds the 8-digit
non-card tier and the 9-digit Amex tier outright. The conflict is real.

**Phase 3 checkout is NOT changed.** An order above the payable range is still a
valid order: it exists, it is owned, it holds stock, and the customer can cancel
it and get the stock back. Nothing about Phase 4 is incorrect in its presence — the
only consequence is a 422 on initiation, which is an honest answer. Narrowing
`MAX_TOTAL_CENTS` at checkout would couple the order domain to a payment
provider's price list and would retroactively invalidate already-persisted orders.
Recorded as a limitation (§17.5), not a defect.

---

## 6. Provider abstraction

### 6.1 Why an interface exists at all

Not speculation: **two real implementations exist from day one**, and the second
is mandatory, not convenient. CI has no secrets, e2e must run against real
Postgres with no network, and `CLAUDE.md` requires every new endpoint to have e2e
coverage and every concurrency test to have a recorded negative control. A
deterministic, in-process provider is the only way to satisfy those rules
simultaneously.

The fake is **DI-selected by configuration**, so e2e boots the real `AppModule`
with real wiring — not an `overrideProvider` mock. That matters concretely in this
repo: `overrideGuard()` is documented as a silent no-op against `APP_GUARD`
registrations, and the lesson generalises — test doubles injected by the test
framework exercise a different graph than production.

### 6.2 The port

```
PAYMENT_PROVIDER (injection token)

interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<ProviderPayment>   // network
  retrievePayment(providerPaymentId: string): Promise<ProviderPayment> // network
  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent     // CPU, throws
  amountLimits(currency: string): AmountLimits | null                  // pure
}

CreatePaymentInput  { orderId, amountMinorUnits, currency, idempotencyKey }
ProviderPayment     { providerPaymentId, clientSecret, amountMinorUnits, currency }
ProviderEvent       { providerEventId, type, providerPaymentId, orderId, amountMinorUnits, currency }
AmountLimits        { minMinorUnits, maxMinorUnits }
```

**Every member has exactly one caller in Phase 4:**

| Member | Caller | Why it cannot be removed |
|---|---|---|
| `createPayment` | initiation, first attempt only | Creates the intent |
| `retrievePayment` | initiation replay, whenever a `Payment` row exists | **Resolves C3.** Lookup by id has no retention window, so the guarantee survives past key pruning |
| `verifyWebhook` | webhook controller | The endpoint's only authentication |
| `amountLimits` | initiation, before `createPayment` | **Resolves C4.** Pure, so it is free to call and deterministic to test |

**Deliberately absent:** `confirmPayment`, `cancelPayment`, `refund`, `capture`,
`void`, `listEvents`, `getCustomer`. None has a caller. `confirmPayment` is absent
by **D11** specifically — confirmation is out-of-band (§7.5), and adding the method
would put a second writer on the paid path beside the webhook. The CANCELLED-order
window (§7.4, case 8) was likewise designed so that it does **not** require
`cancelPayment` — an unconfirmed intent simply expires unused at the provider.

**`ProviderPayment` and `ProviderEvent` are normalised domain shapes, not provider
types.** No Stripe type crosses the port. This is what keeps the service layer
free of `stripe` imports and makes the fake a peer rather than a stub.

**No method takes a `Prisma.TransactionClient`.** This is the inverse of the
`decrementStock(tx, …)` convention and is deliberate: where `tx` being *required*
proves a call must be **inside** a transaction, its *absence* here documents —
at the type level — that a provider call can never be made from inside one (§10).

### 6.3 `StripePaymentProvider` (D10)

**Verified against the published package on 2026-09-23, not recalled:**

| Fact | Value | How verified |
|---|---|---|
| SDK version to add | `stripe@22.6.2` (`latest`) | `npm view stripe dist-tags` |
| Pinned API version | **`2026-08-26.dahlia`** | `apiVersion.js` in the published tarball: `exports.ApiVersion = '2026-08-26.dahlia'` |
| Pin is compiler-enforced | Yes | `lib.d.ts`: `export type LatestApiVersion = typeof ApiVersion;` and `apiVersion?: LatestApiVersion` — **the SDK's own types accept no other string**, so an SDK upgrade that changes the API version becomes a compile error rather than a silent behaviour change |
| Signature verification | `webhooks.constructEvent(payload, header, secret, tolerance?)` | `Webhooks.d.ts:46` |
| Offline signature fixtures | `webhooks.generateTestHeaderString(opts)` | `Webhooks.d.ts:74` |
| Per-request idempotency key | `RequestOptions.idempotencyKey?: string` | `lib.d.ts:109` |
| Node requirement | `>= 18` | `package.json` `engines` (project runs Node 20 ✅) |

The client is constructed once with `apiVersion: '2026-08-26.dahlia'` passed
**explicitly**.

**Corrected after implementation (Task 3, re-confirmed in Task 9). The decision
stands; the reason originally given for it was wrong.** This spec first argued
that omitting `apiVersion` would let the Stripe *account's* default API version —
changeable from a dashboard by a human who has never seen this repository —
govern event payload shapes under a running deployment. **That risk does not
exist for this SDK.** `stripe@22.6.2` falls back to its own `ApiVersion`
constant, not the account default, when `apiVersion` is omitted:
`stripe.core.js:178` reads `version: props.apiVersion || DEFAULT_API_VERSION`,
and Task 3 observed both paths resolving to `2026-08-26.dahlia`, so no runtime
assertion can distinguish them.

**The reason the explicit literal is still mandatory** is the one that was
actually proven: the SDK types declare `apiVersion?: LatestApiVersion`, so the
literal makes an SDK upgrade that moves the API version a **compile error** —
Task 3's control recorded `TS2322: Type '"2025-06-30.basil"' is not assignable
to type '"2026-08-26.dahlia"'` — whereas omitting it lets the upgrade change the
wire version silently, with nothing failing anywhere.

`constructEvent`'s `tolerance` parameter is left at the SDK default. Phase 4 adds
no configuration knob for it — there is no evidence yet that the default is wrong,
and the replay defence does not depend on it (§13.3).

### 6.4 `FakePaymentProvider`

A **real implementation**, living in `src/modules/payments/provider/`, not in
`test/`. It:

- derives deterministic `providerPaymentId`s and client secrets from the order id;
- signs webhook payloads with HMAC-SHA256 over the raw body using `PAYMENT_WEBHOOK_SECRET`, and verifies with a **constant-time** comparison (`crypto.timingSafeEqual`) — the fake must not be a weaker verifier than the thing it stands in for, or the e2e suite proves nothing about the shape of the real path;
- records, per idempotency key, how many `createPayment` calls it served, so a test can assert *exactly one intent was created across N concurrent requests*;
- can **simulate idempotency-key retention expiry** on demand, which is what makes the C3 resolution testable (§15.3, I1);
- returns the same `amountLimits` constant as the Stripe adapter;
- can be told to fail or to return a mismatched amount.

**It must never be selectable in production** — enforced at boot by Joi (§11), not
by convention.

---

## 7. Payment initiation

### 7.1 Route and ownership

`POST /api/v1/orders/:id/payments`

Ownership is **structural**: the order id is a path parameter and the lookup is
`where: { id, userId: request.user.sub }` — the same shape as
`OrdersService.findOneForUser()`. A non-existent order and another user's order
are **both 404**, so existence never leaks. The rejected alternative
(`POST /api/v1/payments` with `{ orderId }` in the body) turns ownership into a
body-field check, where one forgotten `userId` charges someone else's order.

### 7.2 Request body: **empty**

The client supplies **nothing** that affects money. Not amount, not currency, not
order id, not status, not a return URL. The amount is `order.totalCents` and the
currency is `order.currency`, both read from the database inside the same request.

There is no `@Body()` parameter, so the global `ValidationPipe` never inspects the
body and a junk body is ignored rather than rejected. Accepted: an empty DTO class
purely to make `forbidNonWhitelisted` reject it would be decoration, and no
security property depends on it.

**No `Idempotency-Key` header, deliberately — this route differs from checkout.**
`POST /api/v1/orders` needs a client-supplied key because the request creates a
resource the client cannot name in advance. Here the order id already uniquely
identifies the intent, so a client-supplied key would only add a way for one
client to mint two intents for one order by varying it. The key is derived
server-side as `order.id` (§7.3), and `IdempotencyKeyPipe` is not used on this
route.

### 7.3 Algorithm (resolves C3)

```
 1. order ← prisma.order.findFirst({ where: { id, userId } })        [DB, autocommit]
      not found            → 404 'Order not found'
      status = CANCELLED   → 409 'Order is cancelled'
      status = PAID        → 409 'Order is already paid'

 2. limits ← provider.amountLimits(order.currency)                   [pure]
      null                          → 422 'Currency is not supported for payment'
      totalCents outside [min, max] → 422 'Order total is outside the payable range'

 3. payment ← prisma.payment.findUnique({ where: { orderId } })      [DB, autocommit]

 4. if (payment === null) {
      created ← provider.createPayment({                             [NETWORK, no tx]
                  orderId, amountMinorUnits: order.totalCents,
                  currency: order.currency, idempotencyKey: order.id })

      { count } ← prisma.payment.createMany({                        [DB, autocommit]
                    data: { orderId, providerPaymentId: created.providerPaymentId,
                            status: PENDING },
                    skipDuplicates: true })

      payment ← prisma.payment.findUniqueOrThrow({ where: { orderId } })

      if (payment.providerPaymentId === created.providerPaymentId)
        return { http: count === 1 ? 201 : 200, clientSecret: created.clientSecret }
      // else: a concurrent request persisted a different intent — fall through
    }

 5. retrieved ← provider.retrievePayment(payment.providerPaymentId)  [NETWORK, no tx]

 6. return { http: 200, clientSecret: retrieved.clientSecret }
```

**Why `count` decides 201 vs 200:** it is the same signal `CheckoutService` uses
(`replayed`), read from the write itself rather than from a prior read, so two
concurrent first-attempts cannot both claim 201.

**Why step 5 needs no second `createPayment`:** `retrievePayment` is a lookup by
id. The provider's idempotency-key retention window does not apply to it. **This
is the whole resolution of C3** — the durable guarantee is the row, and the key is
only an optimisation for the concurrent window.

### 7.4 Every case the correction demands

| # | Case | Behaviour | Guarantee |
|---|---|---|---|
| 1 | **First initiation** | Steps 1–4; row created; **201** | One intent |
| 2 | **Concurrent initiation** (N requests) | All reach step 4 within the retention window by definition (they are simultaneous). The provider's key dedupe returns the **same** intent to all N. One `createMany` sets `count = 1` → **201**; the rest get `count = 0` → **200**, and all N return the **same** `clientSecret` from their own `created`, with **no extra network call** | Exactly one `Payment` row; exactly one intent created at the provider (asserted by the fake's per-key counter, test P3). The counter alone cannot show how many initiations raced; `mintedIntentsFor()` over the existing `retrievePayment` port is what makes the overlap legible — see the P3 row in §19 |
| 3 | **Client timeout after provider acceptance, local row written** | Retry takes step 3 → row found → step 5 retrieve → **200**, same intent | One intent |
| 4 | **Client timeout after provider acceptance, local row NOT written** (crash between step 4's call and its insert) | Retry **within retention**: same key → same intent → row written → **201**. Retry **after retention**: a **new** intent is created and persisted. The first intent is orphaned | See case 8 |
| 5 | **Retry within provider retention** | Covered by 3 and 4 | One intent |
| 6 | **Retry after provider retention** | If a row exists (the overwhelmingly common case) → step 5 retrieve → **200**, same intent, **retention is irrelevant**. Only the narrow case-4 window can produce a second intent | The row, not the key, is the guarantee |
| 7 | **Webhook arrives before local `Payment` persistence** | The webhook resolves the order from the **signed `metadata.orderId`**, never from a `providerPaymentId` lookup, so it does not depend on step 4 having committed. Order → **PAID**; the payment row is inserted by the webhook. A later initiation then sees `PAID` → **409** | Race-free by construction (test P4) |
| 8 | **No second successful charge caused by our API** | The only path to two intents is case 4's crash-then-post-retention window. The orphaned intent's `clientSecret` was returned **in a response the client never received** — that is the definition of the case. Our API never hands it out again, because step 3 finds the persisted row and step 5 retrieves *that* intent. The orphan is therefore **unreachable by the client by construction**. If it were somehow confirmed anyway, the webhook records the event, `markPaid` fires its CAS once, and the second event is logged as a reconciliation item (§14) | No double charge originates from this API |
| 9 | **No provider call inside a DB transaction** | Steps 1, 3, 4 and the read-back are single autocommit statements. `PaymentsService` never opens a `$transaction` at all | §10.2 |

**The honest boundary, stated rather than hidden:** a crash in the millisecond
window between the provider accepting a create and our row being written, followed
by a retry after the provider's key retention expires, can leave one orphaned,
unconfirmed intent at the provider. It costs nothing, charges nobody, and expires
on the provider's own schedule. Closing it entirely would require a provider
cancel call or a two-phase local write, and neither is warranted by the exposure.

### 7.5 Completion is out-of-band — the demo/integration boundary (D11)

Six statements, each load-bearing:

1. **The project has no browser frontend.** The foundation spec fixes the client as *"Swagger/HTTP only"*, and no phase of the roadmap adds a UI. There is no place for a provider's client-side SDK to run.
2. **Payment initiation is a backend API operation, and it is complete as specified.** `POST /api/v1/orders/:id/payments` creates or reuses the intent and returns the `clientSecret`. That is the entire server-side contract, and §7.3 discharges it in full.
3. **Completion/confirmation is performed out-of-band using provider test tooling** — the Stripe CLI, the test-mode dashboard, or an equivalent provider-side test flow. The provider then emits a **signed** webhook.
4. **The webhook is what changes the order to `PAID`.** Unchanged by this decision, and reinforced by it: with no confirm endpoint, `PaymentWebhookService` → `OrdersService.markPaid` is the *only* path to `PAID` anywhere in `src/`.
5. **A demo-only confirm endpoint is intentionally excluded.** No `confirmPayment` provider method, no confirm route, no frontend. Such a route would exist purely for convenience, would be a **second writer on the paid path** competing with the webhook for authority, and would need its own idempotency, ownership and concurrency story — all to avoid running one CLI command.
6. **This is a demo/integration boundary, not a shortcut around webhook verification.** Nothing about D11 weakens, bypasses or stubs signature verification. The out-of-band tool produces a *genuine, provider-signed* event, and it traverses the exact pipeline in §8.2 — raw body, HMAC verification, dedupe, amount check, CAS. The e2e suite reaches the same pipeline through `FakePaymentProvider`, which **signs and constant-time-verifies with the same rigour** (§6.4); it does not skip verification either. If any future change makes "confirm it locally" a way to reach `PAID` without a verified signature, that change has broken the phase's central invariant, not extended it.

**Operator flow, for the record** (documentation, not code): boot with
`PAYMENT_PROVIDER=stripe` and test-mode credentials → `POST /orders` → `POST
/orders/:id/payments` → complete the returned intent with provider test tooling →
the provider delivers a signed `payment_intent.succeeded` → `GET /orders/:id` shows
`PAID`. This belongs in `README.md` (§18) and requires no endpoint that does not
already exist.

---

## 8. Webhook

### 8.1 Endpoint

`POST /api/v1/payments/webhook`

- **`@Public()` — mandatory.** The provider sends no bearer token. `JwtAuthGuard` is global and fails closed; without `@Public()` every delivery is 401 and no order ever becomes paid.
- **Authentication is the signature**, verified over `request.rawBody`.
- **`@Throttle({ default: { ttl: 60_000, limit: 300 } })`** (D8, C5). Key `default` — any other key is silently ignored.
- Ordinary `/api/v1/*` route: no version-neutral exception, no prefix exclusion.

### 8.2 Pipeline

```
── OUTSIDE ANY TRANSACTION ──────────────────────────────────────────────────
 1. rawBody ← request.rawBody           undefined → throw (logged 500)
 2. event   ← provider.verifyWebhook(rawBody, signatureHeader)
                                        throws → 400 'Invalid signature'
 3. event.type ≠ 'payment_intent.succeeded' → 200, debug log, NO DB write
 4. malformed/unusable payload after a valid signature → 400

── ONE TRANSACTION (ReadCommitted) ──────────────────────────────────────────
 5. { count } ← tx.paymentEvent.createMany({ data: {...}, skipDuplicates: true })
      count = 0 → duplicate delivery → COMMIT, 200                    ◄ dedupe
 6. order ← tx.order.findUnique({ where: { id: event.orderId } })
      null → error log, COMMIT (event recorded), 200                  ◄ reconciliation
 7. amount/currency check against order.totalCents / order.currency
      mismatch → error log, COMMIT (event recorded), 200, NOT paid    ◄ reconciliation
 8. payment row: createMany(skipDuplicates) then conditional update to SUCCEEDED
 9. outcome ← ordersService.markPaid(tx, order.id)                    ◄ CAS
      'paid'        → normal
      'already-paid'→ idempotent no-op
      'cancelled'   → error log 'payment succeeded for cancelled order'
── COMMIT ───────────────────────────────────────────────────────────────────
10. 200 { received: true }
```

### 8.3 Step 8 in detail

```
tx.payment.createMany({ data: { orderId, providerPaymentId,
                                status: SUCCEEDED, succeededAt: now },
                        skipDuplicates: true })

tx.payment.updateMany({ where: { orderId, providerPaymentId, status: PENDING },
                        data:  { status: SUCCEEDED, succeededAt: now } })
```

**Four** outcomes, all correct. The fourth was omitted from the original text and
added after implementation (Task 7 defect 19, confirmed in Task 9):

- **No row existed** (webhook beat initiation, case 7): the insert creates it already `SUCCEEDED`.
- **The matching `PENDING` row existed**: the insert no-ops, the conditional update promotes it exactly once.
- **A row existed with a *different* `providerPaymentId`** (the case-4 orphan was confirmed): both statements no-op. The order is **still marked PAID** in step 9 — the event is authentic and the amount matches — and the divergence is logged as a reconciliation item. Recording the truth beats refusing money that was actually taken.
- **A row under the *same* `providerPaymentId` was already `SUCCEEDED`**, reached by a second **distinct** `providerEventId` for one intent — so the step-5 dedupe does not catch it. Both statements no-op here too, and `succeededAt` is not rewritten.

**The two no-op causes are indistinguishable from inside step 8**, and the code
must not pretend otherwise: a no-op means either a divergent
`providerPaymentId` or an already-`SUCCEEDED` row under the same one, and
nothing in the statements' results says which. **The behaviour is correct in
both cases** — the order is still marked `PAID` in step 9, exactly once, because
the event is authentic and the amount matches. Any log emitted here must
describe the ambiguity rather than assert one diagnosis.

The update is a CAS (`status: PENDING` in the predicate), so a duplicate that
somehow reached step 8 cannot rewrite `succeededAt`.

### 8.4 Amount and currency (resolves C8)

`event.amountMinorUnits === order.totalCents` **and**
`event.currency === order.currency`, both compared as integers/uppercase strings.
The adapter lowercases outbound and uppercases inbound; the domain never sees a
lowercase currency.

On mismatch: **do not mark paid**, record the event, log at error, return **200**.
Never 4xx — the event is authentic; the disagreement is ours (a misconfigured
provider account, a wrong intent, a hand-crafted replay from a different order).

### 8.5 Response contract

| Case | Status | Persisted |
|---|---|---|
| Bad or missing signature header | **400** `Invalid signature` | nothing |
| Valid signature, unsupported event type | **200** | nothing |
| Valid signature, malformed/unusable payload | **400** | nothing |
| Duplicate delivery (same `providerEventId`) | **200** | nothing new |
| Replay of an old event, still-valid signature | **200** | nothing new (dedupe) |
| Event for an unknown order | **200** | event row only |
| Amount or currency mismatch | **200** | event row only |
| Event for an already-`PAID` order | **200** | event row only |
| Event for a `CANCELLED` order | **200** | event row, payment `SUCCEEDED` |
| Success for a `PENDING` order | **200** | event row, payment `SUCCEEDED`, order `PAID` |
| Database failure mid-transaction | **500** | nothing (rollback) |

**The governing rule: only a signature failure and a malformed payload are 4xx.
Everything else is 200 or 500.** A 4xx tells the provider *never send this again*;
a 5xx tells it *try later*. Getting this backwards is the classic webhook bug, and
it is stated here so no reviewer has to infer it.

### 8.6 Supported events (D4) and ordering

**`payment_intent.succeeded` only.** It is the only event that changes
authoritative local state. `payment_intent.payment_failed` would write a field with
no reader — the client learns of a failure synchronously from the provider's
client SDK — and a failed attempt is not terminal for an intent, so a late `failed`
after a `succeeded` would need an explicit ignore rule: a new ordering hazard
bought for no consumer.

**Ordering is therefore a non-issue in Phase 4 *by construction*, not by trusting a
provider guarantee** (no provider offers ordered delivery). One event type, one
terminal transition, guarded by a CAS onto a terminal state. This reasoning is
recorded explicitly so that a future phase adding a second event type knows the
guarantee came from the design, not from the provider.

---

## 9. Module, service and API layout

### 9.1 Files

```
src/modules/payments/
  payments.module.ts
  payments.controller.ts            @Controller('orders')  → POST :id/payments
  payments-webhook.controller.ts    @Controller('payments') → POST webhook   [@Public]
  payments.service.ts               initiation (§7.3)
  payment-webhook.service.ts        webhook application (§8.2)
  dto/payment-response.dto.ts
  provider/
    payment-provider.ts             interface, token, normalised types, AMOUNT_LIMITS
    stripe-payment.provider.ts
    fake-payment.provider.ts
```

Two controllers, one trust posture each (C7). Two `@Controller` classes share the
`orders` prefix with `OrdersController`; Nest permits this because the sub-paths
differ, and `test/routing.e2e-spec.ts` already exists to assert route resolution —
it gains a case for `POST /api/v1/orders/:id/payments`.

### 9.2 `PaymentsModule` imports

`OrdersModule` (for `OrdersService`), `PrismaModule`, `ConfigModule` (global).
It does **not** import `ProductsModule` or `CartModule` — payment never touches
stock or carts.

### 9.3 `OrdersService.markPaid` (D9, resolves C6)

```
markPaid(tx: Prisma.TransactionClient, orderId: string):
  Promise<'paid' | 'already-paid' | 'cancelled' | 'not-found'>
```

- `tx` is **required**, matching `decrementStock(tx, …)` — it can never run outside the caller's transaction.
- The CAS is `tx.order.updateMany({ where: { id, status: PENDING }, data: { status: PAID } })`; `count === 1` → `'paid'`.
- On `count === 0` it re-reads the row to classify — the same shape `OrdersService.cancel()` already uses for its own CAS miss.
- It **never throws**. A `NotFoundException` here would surface as a misleading 404 to the payment provider and trigger permanent retry suppression — the same reasoning that keeps `describeRefusal()` from reusing `findOne()`.

### 9.4 API surface

| Method | Route | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| `POST` | `/api/v1/orders/:id/payments` | Bearer, owner-scoped | *(empty)* | **201** created · **200** replayed | 400 · 401 · 404 · 409 · 422 · 502 |
| `POST` | `/api/v1/payments/webhook` | `@Public()`, signature | raw bytes | **200** `{ received: true }` | 400 · 429 · 500 |

### 9.5 Status codes, complete and explicit

| Case | Status |
|---|---|
| Malformed order uuid (`ParseUUIDPipe`) | **400** |
| Webhook: bad, missing or malformed signature; unusable payload | **400** |
| Initiation without a token, or with an invalid/expired one | **401** |
| Unknown order, **or another user's order** | **404** |
| Order is `CANCELLED`; order is already `PAID` | **409** |
| Cancelling a `PAID` order | **409** |
| Order total outside the payable range; currency not supported for payment | **422** |
| Payment initiated (first time) | **201** |
| Payment initiation replayed; webhook accepted (any outcome) | **200** |
| Provider unreachable, timed out, or errored | **502** |
| Webhook throttled | **429** |
| Local database failure during webhook application | **500** |

**502, not 500, for provider failures:** the fault is upstream and the client may
retry. `PaymentsService` throws `BadGatewayException('Payment provider unavailable')`
with a fixed message; the provider's own error text is logged server-side and
**never** forwarded, per the standing rule that client-facing errors never leak
internals. `HttpExceptionFilter` needs **no change** — `BadGatewayException` is an
ordinary `HttpException`.

### 9.6 Response DTO

`PaymentResponseDto.from(payment, clientSecret)` with a static mapper, per the rule
that controllers never return Prisma objects.

| Field | Included |
|---|---|
| `id`, `orderId`, `status`, `createdAt` | yes |
| `clientSecret` | yes — it is the whole point of the route: nothing can complete the payment without it, and under **D11** whatever completes it is out-of-band (§7.5), never this backend |
| `providerPaymentId` | **no** |

`providerPaymentId` is omitted for **YAGNI, not secrecy** — nothing consumes it,
and the client secret embeds the intent id anyway, so calling its omission a
security measure would be false. Stated plainly so no reviewer is misled.

`OrderResponseDto` changes **nothing structurally**: `status` is already
`@ApiProperty({ enum: OrderStatus })`, so `PAID` appears in Swagger automatically.
Only the description text is reviewed. **No `paidAt` is added to `Order`** — see
§11.3.

**No `GET` payment route ships.** The `POST` is idempotent and returns the same
payload, and `GET /api/v1/orders/:id` already reports `status: PAID`. A read route
is added when a consumer needs one.

---

## 10. Transaction boundaries

Explicit, per phase rule. No step is left to inference.

### 10.1 Checkout — **unchanged**

```
POST /api/v1/orders
 ┌─ TX (ReadCommitted, maxWait 5s, timeout 10s) ─────────────────────────┐
 │ cart lock → idempotency lookup → sorted stock decrements              │
 │ → price snapshot → order insert → cart clear                          │
 └───────────────────────────────────────────────────────────────────────┘
No provider call. Phase 4 adds ZERO lines to CheckoutService.
```

### 10.2 Payment initiation — **zero transactions**

```
 t0 ── READ  order            (autocommit, one statement)          [DB]
 t1 ── PURE  amountLimits()                                        [no I/O]
 t2 ── READ  payment by orderId (autocommit)                       [DB]
 t3 ── CALL  provider.createPayment(...)        ◄ no DB tx open    [NETWORK]
 t4 ── WRITE payment.createMany(skipDuplicates) (autocommit)       [DB]
 t5 ── READ  payment.findUniqueOrThrow          (autocommit)       [DB]
 t6 ── CALL  provider.retrievePayment(...)      ◄ no DB tx open    [NETWORK]  (replay only)
 t7 ── respond
```

**Why no transaction at all:** t4 is a single atomic statement, and the only
invariant — one payment per order — is enforced by the `@@unique([orderId])` index,
not by a transaction. Wrapping t4+t5 would buy nothing; wrapping t0–t5 would put a
network call inside a transaction, which is forbidden.

*Concurrent walk-through:* A and B both reach t4. One `INSERT … ON CONFLICT DO
NOTHING` wins; the other blocks on the unique index until the first commits, then
no-ops with `count = 0`. Both read the same committed row at t5. Both hold the same
intent from t3 because the idempotency key was `order.id`. **No orphan, no second
charge, no lock held across the network.**

### 10.3 Webhook — **one short transaction; verification outside it**

```
 s0 ── read request.rawBody                                     [no DB]
 s1 ── provider.verifyWebhook()   HMAC + constant-time compare  [CPU, no DB]  ◄ OUTSIDE tx
 s2 ── classify / normalise                                     [no DB]
 ┌─ TX (ReadCommitted) ──────────────────────────────────────────────────┐
 │ s3  paymentEvent.createMany(skipDuplicates)     dedupe               │
 │ s4  order.findUnique                                                  │
 │ s5  amount/currency comparison                  pure                  │
 │ s6  payment createMany + conditional update                           │
 │ s7  ordersService.markPaid(tx, orderId)         CAS                   │
 └───────────────────────────────────────────────────────────────────────┘
 s8 ── respond 200                                              [no DB]
```

**Crypto stays outside the transaction** — the same rule as Phase 1's "never hold a
lock across JWT signing" and Phase 3's "no argon2 inside checkout", restated for
the money path. The transaction spans four to six statements with no network and
no CPU-bound work.

**Nothing inside this transaction calls the provider.** Enforced structurally by
the port taking no `tx` (§6.2), and by a runnable test (§15.1).

### 10.4 Cancellation — **Phase 3's transaction remains the synchronisation point**

```
POST /api/v1/orders/:id/cancel
 ┌─ TX (unchanged Phase 3 body) ─────────────────────────────────────────┐
 │ order.updateMany WHERE status = PENDING → CANCELLED   ◄ CAS untouched │
 │ on count = 0 → re-read → 200 (CANCELLED) or 409 (PAID)  ◄ ONLY change │
 │ on count = 1 → sorted incrementStock per line                         │
 └───────────────────────────────────────────────────────────────────────┘
```

Cancel and webhook-success serialise on the **same order row**, which is why
"cancel wins" and "payment wins" are the only two possible outcomes and never a
blend (test P2).

---

## 11. Database design

### 11.1 `OrderStatus` — additive only

```
enum OrderStatus { PENDING  CANCELLED  PAID }
```

Migration: `ALTER TYPE "OrderStatus" ADD VALUE 'PAID';`

**Migration-safety check, stated so it is not rediscovered in CI:** PostgreSQL
forbids *using* a newly added enum value inside the transaction that added it, and
Prisma runs each migration file in a transaction. This migration adds the value
and creates two tables that **do not reference `OrderStatus` at all**, so no
literal `'PAID'` appears. If a future migration ever needs to reference it, it
must be split into two files.

### 11.2 `Payment` (D1, D2)

| Field | Requirement it serves | Why it is not redundant |
|---|---|---|
| `id` | PK, `uuid(7)` | Project convention; client-side generation is required by the factory rule |
| `orderId` **@unique** | One live payment per order | The unique index **is** the invariant, and it is the replay key for §7.3 step 3. Without it, initiation dedupe would be a check-then-act race |
| `providerPaymentId` **@unique** | Webhook cross-reference; detection of the case-4 orphan | Not derivable from `orderId` — it is the provider's opaque id. Uniqueness prevents two intents both claiming one order's payment row |
| `status` (`PaymentStatus`) | Must be able to read `SUCCEEDED` while the order reads `CANCELLED` | The order's status cannot express this: the reconciliation state is precisely *the two disagree* |
| `succeededAt` `DateTime?` | When money was received | `updatedAt` changes on any write and is not a semantic timestamp; `createdAt` is initiation time, not receipt time |
| `createdAt`, `updatedAt` | Project convention (every model carries both) | — |

**Relation:** `order Order @relation(fields: [orderId], references: [id], onDelete: Restrict)`.
`Restrict`, never `Cascade` — orders are never deleted, and `Restrict` states that
rather than quietly authorising a cascade, matching `Order.user`'s posture.

**Indexes:** the two `@@unique` constraints create every index Phase 4 queries
need. No `@@index([status])` — nothing lists by status.

**Deliberately omitted**

| Omitted | Why |
|---|---|
| `amountCents`, `currency` | `Order.totalCents`/`Order.currency` are **immutable after creation** — verified: nothing in `src/` writes them post-insert (checkout creates; `cancel` and `markPaid` touch only `status`/`cancelledAt`). A snapshot would be a guaranteed-identical copy, and a second copy of money is a second thing that can disagree |
| `clientSecret` | S4. Never persisted; `retrievePayment` supplies it (§7.3 step 5). Keeps a credential-shaped value out of the database, backups and logs |
| `provider` / `providerName` | One provider is configured at a time, so the column would be constant. Added the day a second provider ships |
| `attemptCount`, `lastError`, `failureCode` | No reader in Phase 4; D4 ships no failure event |
| `rawProviderPayload` | Storing raw payloads stores whatever PII the provider includes, in a column nothing queries |
| `idempotencyKey` | It is `order.id` by construction (§7.3); storing it would be storing a derivable value |

### 11.3 `PaymentEvent`

| Field | Requirement it serves | Why it is not redundant |
|---|---|---|
| `id` | PK, `uuid(7)` | Convention |
| `providerEventId` **@unique** | **The duplicate-delivery defence.** The unique index is the mechanism; `skipDuplicates` reads it | The provider's id, not ours; nothing else identifies a delivery |
| `type` | Records what was processed; makes the audit trail readable and lets a future phase widen D4 without a migration | Not derivable — unsupported types are not persisted, but supported ones may grow |
| `createdAt`, `updatedAt` | Convention | `updatedAt` is never written after insert; kept for convention consistency rather than making this the one model that deviates |

**Deliberately omitted**

| Omitted | Why |
|---|---|
| `receivedAt` | Identical to `createdAt` — the row is inserted on receipt. Two names for one instant invite drift |
| `payload` | As above: PII in a column nothing reads |
| `orderId` FK | An event for an **unknown** order must still be recordable (§8.5), which a required FK makes impossible and a nullable one buys an index no query uses |
| `processedAt` / `status` | A row exists **if and only if** it was processed, because the insert and the application share one transaction. A status column would be a second source of truth able to disagree with the first |

### 11.4 `Order` — no new columns

`Order` gains **no new columns**. `paidAt` was considered for symmetry with
`cancelledAt` and rejected: payment facts belong on the payment row, and keeping
provider-adjacent state off the row `OrderResponseDto` maps is the same instinct as
the explicit-DTO rule. `Payment.succeededAt` is the timestamp.

Two things do change on the model, neither of them a column:

- the `OrderStatus` enum gains `PAID` (§11.1);
- `Order` gains the **back-relation field** `payment Payment?`, which Prisma
  requires on the other side of §11.2's relation. It is a virtual field — it adds
  no column to the `orders` table, and the migration emits no `ALTER TABLE
  "orders"` beyond the enum change. `OrderResponseDto.from()` is **not** changed to
  include it: the order response carries `status`, and nothing else about payment.

### 11.5 The `skipDuplicates` guarantee — documented vs. repo-verified

The C1 resolution rests on `createMany({ skipDuplicates: true })`. This section
separates what is **guaranteed by Prisma** from what **this repository must verify
itself**, so no reviewer credits the design with more certainty than it has.

**(a) Guaranteed by Prisma's documented behaviour** (Prisma Client reference,
read 2026-09-23):

- `skipDuplicates` does *"not insert records with unique fields or ID fields that already exist"*.
- It is *"Only supported by databases that support `ON CONFLICT DO NOTHING`"*, and *"This excludes MongoDB and SQLServer"* — PostgreSQL is in scope, and this project is PostgreSQL-only (`prisma/schema.prisma` datasource, `postgres:16-alpine` everywhere).

**What Prisma's documentation does *not* contractually promise** is the exact SQL
text emitted for a given call shape. The design does not need that promise; it
needs **atomicity** — that the skip is decided by the database in one statement,
not by a read followed by a write.

**(b) Additionally verified in this repository:**

| Check | Status |
|---|---|
| `skipDuplicates?: boolean` present in the generated client at the pinned version | **Confirmed** — `@prisma/client@6.19.3`; `grep` of `node_modules/.prisma/client/index.d.ts` shows it on every `createManyArgs` |
| `ON CONFLICT DO NOTHING` present in the shipped query engine | **Confirmed by `grep`** of `node_modules/@prisma/engines/**` and `query_engine-*.node`. Indicative, **not conclusive** — the string's presence does not by itself prove it is emitted for this call shape |
| The skip is **atomic** under real concurrency | **To be proven by tests P1 and P3** (§15.3), against real Postgres over real parallel HTTP, each with a recorded negative control |
| The emitted SQL | **Optional** corroboration during implementation via Prisma query logging; recorded in §19 if captured. Not required — P1/P3 test the property that matters |

This is the same posture Phase 3 took toward its native-upsert assumption (test C8):
**prove the behaviour, do not trust the compilation.** Fallback if atomicity does
not hold: a `$queryRaw` `INSERT … ON CONFLICT DO NOTHING` confined to the two dedupe
call sites, with the reason recorded in `CLAUDE.md`.

**One semantic consequence that shapes the code.** `skipDuplicates` skips on **any**
unique conflict, so `count` alone does not identify *which* constraint fired:

- `payment_events` has exactly one unique constraint (`providerEventId`), so `count === 0` is unambiguous — it means *this event was already delivered* (§8.2 step 5).
- `payments` has **two** (`orderId` and `providerPaymentId`), so `count === 0` is ambiguous. This is precisely why §7.3 step 4 re-reads the row and **compares `providerPaymentId`** instead of trusting `count`, and why §8.3 follows its insert with a conditional update. Neither is defensive padding; both are required by the operator's actual semantics.

### 11.6 Growth

`payment_events` grows without bound, exactly like `refresh_tokens`. Queries are by
unique index, so this is disk growth, not latency. → §17.3, owner **Phase 5**.

---

## 12. Configuration (D7)

### 12.1 New variables

| Variable | Purpose | Joi |
|---|---|---|
| `PAYMENT_PROVIDER` | Selects the adapter | `valid('stripe','fake')`, **required, no default**, and narrowed to `'stripe'` when `NODE_ENV=production` |
| `PAYMENT_API_KEY` | Provider credential | required when `PAYMENT_PROVIDER=stripe`, optional otherwise |
| `PAYMENT_WEBHOOK_SECRET` | Webhook HMAC secret (both adapters) | required, minimum length enforced |

All three are added to **`.env.example` and the Joi schema in the same commit**
that introduces them, per `CLAUDE.md` rule 2, and read **only** through
`src/config/configuration.ts`, which gains a `payments` section.

### 12.2 Two fail-fast rules, both testable

1. **Production must reject the fake.** A fake provider silently marking orders paid in production is the worst realistic misconfiguration in this phase, so it aborts **at boot**, not at first request. `src/config/env.validation.spec.ts` already exists and gains cases for it.
2. **`PAYMENT_WEBHOOK_SECRET` uses the existing `requireEnv()` helper** in `configuration.ts` — the same helper `JWT_SECRET` uses, for the identical reason recorded there: an empty HMAC key does not fail loudly, it verifies happily, and silence is the worst failure mode for that class of value.

**No `PAYMENT_WEBHOOK_TOLERANCE_SECONDS`.** The SDK default is used (§6.3); a knob
with no evidence behind it is configuration for a value that never changes.

### 12.3 CI

The e2e and unit jobs set `PAYMENT_PROVIDER=fake` and a throwaway
`PAYMENT_WEBHOOK_SECRET`. **No provider credentials are required anywhere in CI.**
`PAYMENT_API_KEY` is unset, which Joi permits for the fake.

---

## 13. Security model

| Concern | Design |
|---|---|
| **Event authenticity** | HMAC over the raw bytes, constant-time comparison, timestamp tolerance. Delegated to the SDK (Stripe) and implemented with `crypto.timingSafeEqual` (fake). **Never** an IP allowlist, never a shared secret in a query parameter |
| **Raw body** | §5.1–5.3. Absent `rawBody` throws rather than degrading |
| **Replay resistance** | Two independent layers: the signature's timestamp tolerance rejects stale replays, and `payment_events.provider_event_id` rejects any replay inside the window. Neither alone is relied on |
| **Client/server trust boundary** | The client supplies **nothing** that affects money (§7.2). The provider supplies amount and currency, and we **verify them against our own record** rather than trusting them (§8.4) |
| **Ownership** | `where: { id, userId }`; 404 for another user's order, never 403 — existence must not leak |
| **Authorization** | No `@Roles()` anywhere in Phase 4: both routes are correct for any authenticated caller (initiation) or for no caller (webhook). `RolesGuard` stays opt-in |
| **Secret management** | Only `src/config/` reads `process.env`. Secrets never appear in DTOs, Swagger examples, or `.env` (gitignored) |
| **Logging — never** | the webhook secret, the API key, the signature header, the client secret, or the raw payload, at any level |
| **Logging — do** | event id, event type, order id, payment id, and the outcome. `providerPaymentId` in logs is acceptable: it is an opaque reference, not a credential. Stated deliberately rather than left to judgement |
| **Error leakage** | Signature failure returns a bare `Invalid signature` — never "timestamp too old" versus "digest mismatch", which would tell an attacker which half to fix. Provider errors become a fixed `Payment provider unavailable` |
| **Denial of service** | The webhook is unauthenticated and performs HMAC + DB work, so it stays throttled (D8). Cross-references the open trusted-proxy limitation, which it does **not** close |

---

## 14. Failure and recovery model

**The signature-verified webhook is the single authority for paid state.**
Everything else is convenience. Every row below follows from that one sentence.

Under **D11** this is not merely a policy but a structural fact: because no confirm
endpoint exists, there is no other code path in `src/` that could write `PAID`,
even by mistake. The table below therefore contains no "the backend confirmed the
payment" row — **the backend never confirms a payment.**

| Failure | Behaviour | Recovery |
|---|---|---|
| Provider unreachable / times out at initiation | **502**, nothing persisted locally | Client retries; the deterministic key makes a retry safe even if the first call did reach the provider |
| Network dies after the provider accepts, before our response | Intent exists remotely; local row may or may not exist | Retry: row found → retrieve; row absent and within retention → same intent; row absent and past retention → new intent, orphan documented (§7.4 case 4) |
| Client never retries | Unconfirmed intent; order stays `PENDING` holding stock | Existing Phase 5 expiry limitation. **No new gap** |
| Webhook arrives before initiation's local write | Resolved from signed `metadata.orderId` → order `PAID`, payment row inserted by the webhook | Race-free by construction (P4) |
| Webhook delayed by minutes or hours | Order stays `PENDING`; client polls `GET /api/v1/orders/:id` | The CAS is time-independent; the transition applies whenever it lands |
| Webhook duplicated, sequentially or concurrently | `skipDuplicates` → `count = 0` → 200, no second transition | P1 |
| Webhook DB transaction fails (`P2028` saturation, deadlock, lost connection) | Rollback, **500**, nothing partially applied | **The provider's own retry schedule is the retry infrastructure.** This is precisely why Phase 4 needs nothing from Phase 5 (§16) |
| Provider succeeded but our database is down through the provider's entire retry schedule | Order stuck `PENDING` although money was taken | **Accepted, documented** (§17.2). Detection is manual today |
| Amount or currency mismatch | Order not paid; event recorded; error log | Manual; queryable |
| Two intents both succeed | First CAS wins → `PAID`; second event recorded, payment row divergence logged | Manual; extremely unlikely (§7.4 case 8) |
| Order total unpayable by the domain contract | **422** before any provider call; no local or remote state created | Customer cancels; §17.5 |
| Amount inside our contract but refused by the provider (method/network/region limit, §5.4.1) | **502**, nothing persisted | Client retries or the customer cancels the order |
| Intent created but **never confirmed** (D11: confirmation is out-of-band) | Order stays `PENDING` holding stock; no webhook is ever emitted, because none is owed | Customer cancels; otherwise the Phase 5 expiry limitation applies. **Not a Phase 4 defect** — the backend's contract ended when it returned the `clientSecret` (§7.5) |

---

## 15. Test strategy

`maxWorkers: 1` stays. Concurrency suites `await app.listen(0)` in `beforeAll`,
pass `createTestApp([], { throttleLimit: 0 })`, mint tokens via
`app.get(TokenService).signAccessToken(user)` rather than `/auth/login`, and assert
no response is a 500. The e2e advisory lock applies unchanged.

`test/factories/` gains `payment.factory.ts` and `payment-event.factory.ts`,
inserting through the Prisma client — never `$executeRaw` — because `uuid(7)` ids
are generated client-side. `truncateAll()` needs **no change**: it reads
`pg_tables` at runtime, so the two new tables are covered automatically.

**Testing assumption implied by D11.** No test confirms a payment, because no code
path can. Every test that needs a paid order reaches `PAID` the same way production
does: by delivering a **signed** `payment_intent.succeeded` to
`POST /api/v1/payments/webhook`, with the signature produced by
`FakePaymentProvider`'s HMAC helper. The suite therefore exercises the identical
pipeline the out-of-band tooling drives in a real deployment — raw body, signature
verification, dedupe, amount check, CAS. **No test bypasses signature
verification**, and there is no test-only route or flag that reaches `PAID` without
one. A fixture that wrote `status: PAID` directly through a factory would prove
nothing about this phase and must not be used to set up webhook tests; the
already-paid cases are set up by delivering a first legitimate event.

### 15.1 Unit tests

**`PaymentsService`**
- another user's order → 404; unknown order → 404
- `CANCELLED` → 409; `PAID` → 409
- unsupported currency → 422; total below min → 422; total above max → 422 — **and the provider is never called** in any of the three
- the amount passed to `createPayment` equals `order.totalCents` exactly, and the currency equals `order.currency`; **no client-supplied value reaches the provider**
- the idempotency key equals `order.id`
- provider throws → `BadGatewayException` whose message contains **no** provider text
- **C3 resolution (S1):** when a `Payment` row exists, `createPayment` is **never** called and `retrievePayment` is called with the persisted id
- first attempt: `createMany` `count = 1` → 201; `count = 0` → 200
- read-back row with a divergent `providerPaymentId` → falls through to `retrievePayment`

**`PaymentWebhookService`**
- unsupported type → no DB write at all
- duplicate event → no second transition
- unknown order → event recorded, order untouched
- amount mismatch; currency mismatch (including **case** differences) → not paid
- `markPaid` outcomes `'paid'` / `'already-paid'` / `'cancelled'` each take their branch and produce the right log level
- payment row absent / present-and-`PENDING` / present-with-divergent-id → all three §8.3 outcomes

**`OrdersService.markPaid`**
- `PENDING` → `'paid'`; `PAID` → `'already-paid'`; `CANCELLED` → `'cancelled'`; unknown → `'not-found'`; **never throws**

**`OrdersService.cancel`** — regression: `PAID` → 409, and stock is not restored

**`StripePaymentProvider`** — offline, deterministic, no network:
- `verifyWebhook` with a header built by `webhooks.generateTestHeaderString`: valid → parses; tampered body → throws; wrong secret → throws; stale timestamp → throws
- currency normalisation, both directions (C8)
- `apiVersion` is passed explicitly and equals `2026-08-26.dahlia`

**`FakePaymentProvider`** — the same four signature cases against its own HMAC;
per-key create counting; retention simulation; identical `amountLimits`

**Structural guard — no provider I/O inside a transaction:** a test wraps
`PrismaService.$transaction` so it raises a flag for the duration of the callback,
and injects a provider whose every method asserts the flag is false. Runs across
initiation and webhook application. **This fails if a future change moves a
provider call inside a transaction** — a runnable check, not a comment.

### 15.2 Deterministic e2e

`test/payments.e2e-spec.ts` and `test/payments-webhook.e2e-spec.ts`.

**Initiation:** `PENDING` → 201 · replay → 200 with an identical payment id and
provider id · `CANCELLED` → 409 · `PAID` → 409 · unknown order → 404 ·
**another user's order → 404 (not 403, not 200)** · no token → 401 · malformed
uuid → 400 · total above max → 422 · total below min → 422 · unsupported currency
→ 422.

**Webhook:** valid signature + success → order `PAID`, payment `SUCCEEDED` ·
**bad signature → 400 and the order is still `PENDING`** · missing signature header
→ 400 · malformed payload → 400 · unknown event type → 200 with **no**
`payment_events` row · unknown order → 200, event row present, no order change ·
amount mismatch → 200, order still `PENDING` · currency mismatch → same ·
`CANCELLED` order + success → 200, order still `CANCELLED`, payment `SUCCEEDED` ·
duplicate delivery → 200 twice, one event row, one transition.

**Raw-body regression:** a test that fails if the body is ever parsed before
verification. Cheap insurance against a silent, total-outage-class bug.

**Stock:** paying **never** changes `stockQuantity` — asserted with the existing
`assertStockConserved` helper. Cancelling a `PAID` order → 409 and stock unchanged.

**Routing/Swagger:** both new routes resolve under `/api/v1/*` and appear in the
Swagger document with `@ApiTags`, `@ApiOperation` and `@ApiResponse`.

### 15.3 Concurrency and control tests — `test/payments-concurrency.e2e-spec.ts`

Every row uses **real HTTP** through a listening server, **real concurrency**
(`Promise.all`), **real Postgres**, asserts exact outcomes, asserts no 500, and
**ships only after its negative control has been recorded as failing** (§19).

| ID | Scenario | Exact assertion | Negative control it must fail against |
|---|---|---|---|
| **P1** | N concurrent duplicate deliveries of one event | exactly 1 `payment_events` row; order `PAID`; 1 payment row with `status = SUCCEEDED`; all N responses 200; no 500 | replace `createMany(skipDuplicates)` + CAS with read → check → update |
| **P2** | concurrent `cancel` + webhook success on one order | final state is **exactly one of** {`PAID`, stock **not** restored} or {`CANCELLED`, stock restored **once**, payment `SUCCEEDED`}; never `PAID` with stock restored; `assertStockConserved`; no 500 | remove the `status: PENDING` predicate from `markPaid`'s CAS |
| **P3** | N concurrent initiations on one order | exactly 1 `payments` row; **the fake recorded exactly 1 `createPayment` for that key**; exactly one 201 and N−1 × 200; all N return the same `clientSecret`; no 500 | replace the deterministic key with a random key per call |
| **P4** | webhook delivered before the local `Payment` write commits | order reaches `PAID`; payment row exists `SUCCEEDED`; no 500 | resolve the order by `providerPaymentId` lookup instead of signed `metadata.orderId` |
| **I1** | *(deterministic, not a race)* replay **after** simulated provider key-retention expiry | the response's `clientSecret` belongs to the **persisted** `providerPaymentId`; exactly 1 payment row; exactly 1 intent ever handed to the client | remove the §7.3 step-3 row lookup, so initiation always calls `createPayment` — must produce **a second intent**. It does **not** on its own produce an inconsistent `clientSecret`: a **second** control, additionally neutralising step 4's persisted-row re-read and `providerPaymentId` comparison, is required for that (see below) |
| **A1** | *(deterministic)* order total above `maxMinorUnits`, below `minMinorUnits`, and unsupported currency | 422 in all three; **the fake recorded zero `createPayment` calls**; no payment row | move the limit check to after the provider call — must create an intent for an unpayable order |

**Per `CLAUDE.md` and Phase 3 §8.3: a green run alone is never evidence.** If a
naive version does not fail, the test is not exercising the property hard enough
and the task is blocked until it does. I1 and A1 carry controls even though they
are not races, because both protect design decisions (C3, C4) that a future
refactor could silently undo.

**I1's control cell, corrected after implementation (Task 8, independently
re-verified by its reviewer).** This spec originally claimed the single
step-3-removal control would produce *"a second intent **and** a `clientSecret`
inconsistent with the persisted row."* Measured, it produces only the second
intent (`createCountFor` 2 instead of 1) — the `clientSecret` assertions still
**pass**, because §7.3 step 4 re-reads the persisted row, compares
`providerPaymentId`, and on a mismatch falls through to
`retrievePayment(<persisted id>)`. A second control, which also neutralises that
comparison, is what produces the divergence the original wording described
(`…_2_secret_2` returned while the persisted row holds `…_1`).

**The architecturally useful consequence: C3 rests on two independent defences,
where this spec documented one.** Step 3 keeps a second intent from ever being
minted; step 4 keeps a minted-anyway intent from reaching the client. Either
alone preserves the client-visible guarantee, which is why one control cannot
demonstrate both. The spec previously attributed both effects to step 3.

### 15.4 What is deliberately **not** covered

No test talks to a real provider. The Stripe adapter's **network** behaviour — real
retries, real error shapes, the real intent lifecycle — is unverified by CI.
Mitigated by keeping the adapter thin enough to read in one sitting, and recorded
as a limitation (§17.4) rather than implied to be covered.

---

## 16. Phase 4 / Phase 5 boundary

**Phase 4 owns:** initiation, payment and event persistence, provider integration,
signature-verified webhook handling, the `PENDING → PAID` transition, and payment
idempotency and reliability.

**Phase 5 keeps, untouched:** Redis, BullMQ, Redis-backed throttler storage,
`PENDING`-order expiry, automatic stock release, the `refresh_tokens` purge, the
new `payment_events` purge, and automated reconciliation.

**The one thing that normally leaks, and why it does not here.** Payment systems
usually want a background retry worker. **Phase 4 needs none**, because a failed
webhook returns 500 and the provider's own retry schedule *is* the retry
infrastructure. This is an architectural argument, not an omission, and it is
recorded so that a future reader does not "fix" the missing queue.

**Phase 4 adds one new expectation for Phase 5, and it is already satisfied:** the
expiry job must never cancel a `PAID` order. Phase 3's `cancel()` CASes on
`status: PENDING`, so reusing that path — which the existing limitation entry
already mandates — skips `PAID` orders with no change.

**Phase 4 makes one existing limitation slightly worse, honestly:** an abandoned
payment form now produces `PENDING` orders at a higher rate than Phase 3 did, so
the stock-holding entry gets a sentence saying so.

---

## 17. Deferred limitations to be recorded

Prepared here; `docs/deferred-limitations.md` is **not** edited by this task. Each
entry closes by shipping the fix, never by deletion.

### 17.1 A payment that succeeds after its order was cancelled is recorded but not refunded

**Owner:** unscheduled (refunds).
**Why deferred:** refunds need a provider refund call, a refund state model, and a
policy decision about who may trigger one — a phase of its own, and D5 deliberately
keeps cancellation unblocked rather than closing the window by making orders
un-cancellable.
**What happens today:** the order stays `CANCELLED`, the payment is recorded
`SUCCEEDED`, an error-level log is emitted, and 200 is returned so the provider
stops retrying. The state is queryable:
`payments.status = 'SUCCEEDED'` joined to `orders.status = 'CANCELLED'`.
**What a future phase must do:** call the provider's refund API for exactly these
rows, exactly once, with its own idempotency guarantee.

### 17.2 There is no automated reconciliation between provider state and local state

**Owner:** Phase 5 (scheduled jobs).
**Why deferred:** a sweep is scheduled work, and scheduled work arrives in Phase 5.
**What happens today:** every divergence (unknown order, amount mismatch, divergent
`providerPaymentId`, provider-succeeded-while-our-database-was-down) is recorded
and logged at error level, and is detectable by query — but nothing looks
automatically, so detection depends on someone reading logs.
**What a future phase must do:** a periodic job comparing provider payment state
against local `Payment`/`Order` state and reporting divergences.

### 17.3 `payment_events` rows are never deleted

**Owner:** Phase 5 (Redis + BullMQ).
**Why deferred:** identical in shape to the existing `refresh_tokens` entry.
**What happens today:** one row per accepted delivery, forever. This is disk growth,
not latency — the only lookup is by unique index.
**What a future phase must do:** extend the same purge job; add an index on the
timestamp used for the cutoff at that time, since no current query needs one.

### 17.4 Real provider network behaviour is not covered by CI

**Owner:** unscheduled.
**Why deferred:** CI has no provider credentials by design (§12.3), and real network
behaviour cannot be made deterministic.
**What happens today:** `FakePaymentProvider` covers every branch of the service
layer and the full signature pipeline; the Stripe adapter's verification is
unit-tested offline with the SDK's own header generator; its HTTP behaviour is
exercised only by hand against Stripe test mode.
**What a future phase must do:** a manually triggered smoke test against provider
test mode, kept out of the required CI path.

### 17.5 Not every `PENDING` order is payable

**Owner:** accepted by design.
**Why deferred:** Phase 3's `MAX_TOTAL_CENTS` is the `INT` bound and predates any
provider; narrowing it at checkout would couple the order domain to a provider's
price list and retroactively invalidate persisted orders.
**What happens today:** an order outside the payable range (or in an unsupported
currency) returns **422** on initiation, before any provider call. The order
remains valid and cancellable, and its stock returns on cancel.
**What a future phase must do:** nothing, unless a product decision says such
orders should be impossible to create — at which point the constraint belongs in
checkout, with a migration story for existing rows.

### 17.6 Amendment to the existing stock-holding entry

`PENDING orders hold stock indefinitely` (owner Phase 5) gains: *Phase 4 increases
the rate at which such orders appear, because an abandoned payment attempt leaves a
`PENDING` order behind. The mitigation is unchanged — the customer can cancel — and
the fix is unchanged: a periodic job reusing the existing cancellation path.*

---

## 18. Documentation expectations

Delivered by the implementation plan's tasks, not by this spec:

1. **`CLAUDE.md`** — a Phase 4 section in the established voice, covering: the webhook as sole authority for `PENDING → PAID`; `createMany(skipDuplicates)` as the dedupe idiom, **why it is not a caught `P2002`**, and why `count` alone is ambiguous on `payments` (§11.5); the local `Payment` row as the durable idempotency guarantee **and** the bounded nature of provider key retention; `NEST_APP_OPTIONS` as the construction seam beside `configureApp()`; the port taking no `tx` as a structural no-I/O-in-transaction guarantee; the pinned API version; `PAYMENT_PROVIDER=fake` being rejected in production; the 422 payable-range contract and why the maximum is the lowest documented tier; `markPaid` living in `OrdersService`; and **D11 — no confirm endpoint, completion is out-of-band, and this is not a shortcut around verification**.
2. **`README.md`** — mark Payments ✅, move the current phase to Phase 5, document the three new env vars, and add the §7.5 operator flow for completing a payment with provider test tooling.
3. **`.env.example`** — the three new variables, in sync with the Joi schema.
4. **`docs/deferred-limitations.md`** — §17.1–17.5 added, §17.6 amended.

---

## 19. Evidence

Filled in before Phase 4 can be called done. An empty cell at review time means the
corresponding claim in this spec is **unproven**, and the phase is not done —
with the single exception of a row this table itself marks *optional*, which
carries no claim the other rows do not already prove (see **Emitted dedupe SQL**).

Filled in Task 9 from the recorded task reports; line references are to
`test/payments-concurrency.e2e-spec.ts` unless stated otherwise. Every control
below was applied by hand, observed, and reverted, with `git diff src/` confirmed
empty between them. Where a property is only partly proven, the cell says so.

| Item | What must be recorded | Recorded |
|---|---|---|
| **P1** | naive implementation, its failing output, and the passing output | **Proven (Task 8).** Shipped `createMany({ skipDuplicates: true })` over 20 concurrent duplicate deliveries: `{ 200: 20 }`, exactly 1 `payment_events` row, 1 `payments` row `SUCCEEDED`, order `PAID`, no 500s. Control (`findUnique` → check → `create`): `{ 200: 8, 409: 12 }`, failing on its own assertion at `:226` (`- "200": 20 / + "200": 8, + "409": 12`). `P2002` is caught nowhere in `src/modules/payments/` or `src/modules/orders/`; the 409s come from `HttpExceptionFilter`'s central map. **The split is itself the overlap measurement:** 12 transactions blocked on the unique index means ≥13 were in flight, and a serialised run cannot produce 409s at all. Reproduced byte-identically by the Task 8 reviewer. This closes §11.5(b). **Progression, recorded rather than smoothed over:** Task 7's sequential read-then-create control was a genuine **null result** (webhook e2e 21/21 still passed — sequentially the two implementations are identical, and the only unit failure was a mock-surface `TypeError`, which was correctly declined as not firing on its own assertion). C1's *decision* is bound deterministically by Task 7's second variant, `skipDuplicates: false` (expected 200, got 409); C1's **atomicity** property was unproven until P1 |
| **P2** | as above, including the stock-conservation figures on both sides | **Proven (Task 8).** Shipped: order `CANCELLED`, stock back to 10 of 10 restored **exactly once**, cancel 200, webhook 200, payment `SUCCEEDED` (recorded for reconciliation, not refunded — §17.1), `assertStockConserved` holds at 10 + 0 held = 10. Control (`status: PENDING` removed from `markPaid`'s CAS): order `PAID` **with stock restored** — goods both sold and handed back — failing at `:274` (`Expected: false / Received: true`). The illegal-state assertion is placed before both legal branches on purpose, so it is evaluated whoever wins. **Partial:** the `PAID`-wins branch (cancel refused 409, stock not restored) is asserted but never *exercised* here — the cancel won 3/3 instrumented runs. It is covered deterministically by `test/orders.e2e-spec.ts:309` |
| **P3** | as above, including the fake's `createPayment` call count on both sides | **Proven (Task 8).** Shipped (`idempotencyKey: order.id`) over 15 concurrent initiations: `{ 201: 1, 200: 14 }`, intents the provider holds for the order **1**, `createCountFor(order.id)` **1**, 1 `payments` row, 1 distinct `clientSecret` and 1 distinct id returned. Control (`randomUUID()` per call): response codes `{ 201: 1, 200: 14 }` — **identical, and therefore provably not the discriminator** — intents held **7** (6 orphaned at the provider), `createCountFor(order.id)` **0**; fails at `:311` (`Expected: 1 / Received: 7`). **The plan's stated control signal was wrong and is superseded:** it expected the counter to *exceed* 1, but `createCounts` is keyed by the idempotency key, so a per-call key records nothing under the order's id and reads 0 — a signal an accidentally serialised run would also produce. The held-intent probe (`mintedIntentsFor()`, over the existing `retrievePayment` port, no `src/` change) is what makes the concurrency legible: 7 of 15 initiations reached `createPayment` before the winner committed |
| **P4** | as above | **Proven (Task 8), in two forms; the deterministic one is the proof.** P4b (webhook for an order with no payment row at all) shipped: webhook 200, order `PAID`, 1 `payments` row `providerPaymentId = pi_never_initiated` `SUCCEEDED`. Control (resolve the order by `providerPaymentId` lookup instead of the signed `metadata.orderId`): order `PENDING`, 0 payment rows, log `Webhook evt_… references unknown order …`; fails at `:369` (`Expected: "PAID" / Received: "PENDING"`). The order-status assertion precedes the payment read deliberately, so the control cannot die on a Prisma `P2025` instead of on the assertion that matters. Concurrent form shipped: order `PAID`, 1 `payments` / 1 `payment_events` row in every interleaving; control `PENDING` in **3 of 3** runs. Initiation's side is checked against the closed set `[200, 201, 409, 502]` with the 502 interleaving named at the call site — it is a `FakePaymentProvider` property (the fake only holds ids it minted), **not** production behaviour, because `recordPayment` and `markPaid` commit atomically, so a real initiation hits the 409 status guard first. `expectNoServerErrors` stays strict on the webhook; the rule was narrowed, not waived |
| **I1** | the post-retention replay result with and without the row lookup, showing the divergent `clientSecret` in the naive run | **Proven (Task 8), and this row's own prediction corrected — see §15.3.** Shipped, replaying after simulated key-retention expiry: `{ 200: 3 }`, `clientSecret` identical to the first and containing the persisted `providerPaymentId`, `createCountFor(order.id)` **1**, 1 intent held, 1 `payments` row. Control 5a (the §7.3 step-3 row lookup removed, exactly as this spec prescribed): `createCountFor` **2**, 2 intents held, fails at `:446` (`Expected: 1 / Received: 2`) — **but the `clientSecret` assertions still PASSED**, so 5a alone does *not* show the divergence this row originally demanded. Control 5b (5a **plus** step 4's `providerPaymentId` comparison neutralised) does: `Expected "pi_fake_…_1_secret_1" / Received "pi_fake_…_2_secret_2"`. Independently re-verified by the Task 8 reviewer, which ran 5a itself and saw `createCountFor` fail while the secret assertions passed. **Consequence: C3 rests on two independent defences where this spec documented one** |
| **A1** | the three 422 cases with and without pre-flight limit checking, showing an intent created for an unpayable order in the naive run | **Proven (Task 8, numbers corrected in its fix round and independently re-verified).** Shipped: all three cases (total above the maximum, below the minimum, unsupported currency) return **422**, `createCountFor` **0** for all three, **0** `payments` rows. Control (limit check moved to after `createPayment`): statuses `{ 422: 3 }` — **identical on both sides, which is exactly why the assertion is on the provider's counter and never on the status** — and counters `{"above":1,"below":1,"foreign":1,"payments":0}`; fails at `:476` (`Expected: 0 / Received: 1`). **The control strands three intents, not one.** `createPayment` runs before the limit lookup under that control, so the unsupported-currency order reaches the provider too. The originally recorded `0` for both `below` and `foreign` was **wrong** — unobservable from the aborted run and incorrect — and is superseded by these re-measured values, taken with temporary instrumentation in the test and both files restored byte-for-byte afterwards. A1b: `totalCents = 50` and `99_999_999` both return **201** with `createCountFor === 1`, so the §5.4.1 bounds are inclusive |
| **Stripe pin** | `stripe` version installed and the `apiVersion` string, re-confirmed from `node_modules` after `npm install` (expected `22.6.2` / `2026-08-26.dahlia`) | **Confirmed (Task 3).** `npm install stripe@22.6.2 --save-exact`; `package.json` shows `"stripe": "22.6.2"`, and `node_modules/stripe/package.json:3` confirms `22.6.2` after install. `apiVersion` string `'2026-08-26.dahlia'`, read from `cjs/apiVersion.js` (`exports.ApiVersion = '2026-08-26.dahlia'`) directly, because the package's `exports` map does not expose that path. Control: substituting `'2025-06-30.basil'` **fails twice** — `npm run build` reports `stripe-payment.provider.ts:63:40 - error TS2322: Type '"2025-06-30.basil"' is not assignable to type '"2026-08-26.dahlia"'`, and the unit assertion reports `Expected: "2026-08-26.dahlia" / Received: "2025-06-30.basil"`. **Honest limit:** no *runtime* assertion can distinguish the pin from omitting the option, because this SDK's own default resolves to the same constant (both paths observed as `2026-08-26.dahlia`). That is why §6.3's stated rationale was corrected in Task 9 while D10 itself stands: the compile error is the real guarantee |
| **Enum migration** | confirmation that `ALTER TYPE … ADD VALUE 'PAID'` applied cleanly in one migration file on PostgreSQL 16 | **Confirmed (Task 1).** One file, `prisma/migrations/20260923235943_phase4_payments/migration.sql`, carrying `CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED')`, `ALTER TYPE "OrderStatus" ADD VALUE 'PAID'`, both new tables, all three unique indexes (`payments_order_id_key`, `payments_provider_payment_id_key`, `payment_events_provider_event_id_key`) and the `ON DELETE RESTRICT` FK. `grep -c "'PAID'"` returns **1**, and the only `PAID` occurrence is the `ALTER TYPE` line — neither new table references `OrderStatus`. Applied in a single transaction without error on PostgreSQL 16: `DEFAULT 'PENDING'` is legal because `PaymentStatus` is *created* in the same transaction, and PostgreSQL's restriction applies only to `ADD VALUE` on a pre-existing type. No second migration file was needed and none was created; the file was not hand-edited. Every e2e run since reports `4 migrations found` / `No pending migrations to apply` |
| **No-I/O guard** | confirmation that the structural test fails when a provider call is moved inside a transaction | **Confirmed (Task 5), with the first attempt discarded as a false signal.** Control: `createPayment` wrapped in `this.prisma.$transaction(…)`. **Both** structural tests then fail on their own assertions — `expect(jest.fn()).not.toHaveBeenCalled() / Received number of calls: 1` at `payments.service.spec.ts:354`, and `Received promise rejected instead of resolved / Rejected to value: [BadGatewayException: Payment provider unavailable]`, the in-transaction signal reaching the caller as a refusal. The first run instead died with `TypeError: Cannot read properties of undefined (reading 'providerPaymentId')` — the brief's bare `$transaction` mock resolved `undefined`, so the service crashed *before* the assertion; that run was **not** counted, and `$transaction` was given a pass-through implementation before re-running. Task 7 adds a complementary structural pin for `PaymentWebhookService` (`design:paramtypes` shows only `PrismaService` and `OrdersService`, so no provider is reachable at all), with its own firing control; the port's absent `Prisma.TransactionClient` parameter is the type-level half |
| **Emitted dedupe SQL** | *optional* — Prisma query log for one `createMany({ skipDuplicates: true })`, if captured. Corroboration only; P1/P3 carry the actual proof (§11.5) | **Not captured, and deliberately not chased.** This row is optional by its own wording and carries no claim P1 does not already prove behaviourally; `ON CONFLICT DO NOTHING` is present in the shipped query engine (§19.1, indicative only). Left unrecorded rather than padded |
| **Swagger / route inventory** *(row added in Task 9)* | §15.2's documentation clause and §20 item 20: both new routes appear in the OpenAPI document with `@ApiTags`, `@ApiOperation` and `@ApiResponse`, and exactly two new routes exist | **Proven (Task 9).** `test/swagger.e2e-spec.ts` builds the document with `SwaggerModule.createDocument` against the app `createTestApp([], { throttleLimit: 0 })` returns (11 tests). Recorded: 19 paths / 22 operations in total, pinned as an exact set; exactly two match `/payment/i` — `POST /api/v1/orders/{id}/payments` and `POST /api/v1/payments/webhook` — which is the D11 inventory check. The two layers are distinct: the exact-set assertion on 19 paths / 22 operations catches **any** added route whether or not its path contains `payment`, while the `/payment/i` count is what names a confirm or admin-refund route specifically. Each route asserted for `tags` containing `payments`, a non-empty `summary`, and the **exact set** of documented response codes (`200,201,400,401,404,409,422,502` for initiation; `200,400` for the webhook). Decorator-deletion controls, each failing on its own assertion with the other 10 tests passing: removing initiation's 502 `@ApiResponse` → `- "502"` at `:134`; removing the webhook's `@ApiTags` → `Expected value: "payments" / Received array: ["PaymentsWebhook"]`; removing the webhook's `@ApiOperation` → `Expected: "string" / Received: "undefined"`. **Known gap, left open:** §9.4 also lists 429 and 500 for the webhook, which are **not** documented by `@ApiResponse` (Task 6 minor M2). The assertion records what is actually documented rather than passing vacuously or failing; closing M2 means adding decorators to `payments-webhook.controller.ts`, a `src/` change outside Task 9's documentation-only scope |

### 19.1 Verification items closed before implementation

These two were carried as verification tasks in the draft. **Both are now closed**,
with sources; neither remains an open question.

| Item | Result | Source and method |
|---|---|---|
| **Stripe amount limits** | **Closed.** USD minimum **`50`** minor units; maxima are tiered — 12 digits (`999_999_999_999`) most card networks, 9 digits (`999_999_999`) American Express, 8 digits (`99_999_999`) non-card in most currencies. Locked contract: `USD → { 50, 99_999_999 }`, all other currencies `null`, choosing the **lowest** tier because the payment method is unknown at initiation. Documented caveats carried into §5.4.1: networks/methods may impose stricter limits, and the minimum depends on **settlement** currency | Stripe, *Supported currencies* → §"Minimum and maximum charge amounts", `https://docs.stripe.com/currencies`, read 2026-09-23. Quoted verbatim in §5.4.1 |
| **Prisma `skipDuplicates`** | **Closed, with the guarantee split honestly.** *Documented:* skips records whose unique/ID fields already exist; *"Only supported by databases that support `ON CONFLICT DO NOTHING`… This excludes MongoDB and SQLServer"* — PostgreSQL in scope. *Not documented:* the exact SQL per call shape. *Repo-verified:* the option exists on every `createManyArgs` in the generated client at `@prisma/client@6.19.3`, and `ON CONFLICT DO NOTHING` is present in the shipped query engine (indicative, not conclusive). *Still to be proven:* atomicity under concurrency, by P1/P3 with negative controls | Prisma Client reference, read 2026-09-23; `grep` of `node_modules/.prisma/client/index.d.ts` and `node_modules/@prisma/engines/**`. Full split in §11.5 |

---

## 20. Definition of Done

1. One migration adds `OrderStatus.PAID`, `PaymentStatus`, and the `payments` and `payment_events` tables, with the three unique constraints in §11.
2. `POST /api/v1/orders/:id/payments` and `POST /api/v1/payments/webhook` behave exactly as §9.4, §9.5, §7.3 and §8.2 specify — every status code in §9.5 asserted by a test.
3. Another user's order returns **404** on initiation, asserted in e2e.
4. The webhook is the **only** code path that writes `OrderStatus.PAID`, and it does so through `OrdersService.markPaid`. Verified structurally at review: `markPaid` is the sole writer of `PAID` anywhere in `src/`, and `PaymentWebhookService` is its sole caller — both checkable by grep, and both asserted by the unit tests in §15.1.
5. A duplicate webhook delivery — sequential and concurrent — produces exactly one `payment_events` row and exactly one transition (P1).
6. Concurrent initiation produces exactly one `Payment` row and exactly one provider intent (P3).
7. A replay after simulated key-retention expiry returns the **persisted** intent (I1) — the C3 resolution is proven, not asserted.
8. An order outside the payable range returns 422 with **zero** provider calls (A1) — the C4 resolution is proven.
9. Cancel-versus-webhook produces exactly one of the two legal outcomes, with stock conserved (P2).
10. A bad signature returns 400 and leaves the order `PENDING`.
11. Paying never changes `stockQuantity`, asserted with `assertStockConserved`.
12. Cancelling a `PAID` order returns 409 and restores no stock; cancelling a `CANCELLED` order still returns 200.
13. **No provider call occurs inside any Prisma transaction**, proven by the structural test, not by inspection.
14. `CheckoutService` is unchanged; `OrdersService.cancel`'s CAS predicate is unchanged.
15. The app refuses to boot with `PAYMENT_PROVIDER=fake` under `NODE_ENV=production`, and refuses to boot without `PAYMENT_WEBHOOK_SECRET`.
16. CI is green with **no provider credentials configured**.
17. `npm run lint:ci`, `npm run build`, `npm test`, `npm run test:e2e` all green.
18. §19 is complete and §18's documentation has landed.
19. **No Redis, no BullMQ, no scheduled or background job, no expiry logic, no refund code, no admin payment route**, and exactly one new runtime dependency (`stripe`).
20. **D11 holds in the shipped code:** no confirm-payment route, no `confirmPayment` provider method, no frontend, and no test-only path that reaches `PAID` without a verified signature. Checkable by grep for `confirm` across `src/` and `test/`, and by the route inventory in the Swagger document — exactly two new routes exist.
21. `README.md` documents the out-of-band completion flow (§7.5) using only routes that already exist.

---

## 21. Open questions

**None.** D1–D11 and S1–S5 are locked, and the two items the draft carried as verification
tasks are closed with sources in §19.1:

- **Amount limits** — verified against Stripe's published tables; the contract is locked at `USD → { 50, 99_999_999 }` with the reasoning and caveats in §5.4.1.
- **`skipDuplicates`** — Prisma's documented guarantee and this repo's additional verification are separated in §11.5, with the remaining property (atomicity under concurrency) assigned to tests P1/P3 and a `$queryRaw` fallback if it fails.

One item remains a **task**, not a question: P1–P4, I1 and A1 must each record a
failing negative control in §19 before the phase can be called done. A green run
alone is never evidence. That is execution, not an unresolved design decision.

**This spec is ready to become an implementation plan.**
