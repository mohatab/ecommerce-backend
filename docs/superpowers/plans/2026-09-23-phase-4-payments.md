# Phase 4 — Payments and Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship owner-scoped payment initiation and a signature-verified webhook that is the sole authority for `PENDING → PAID`, transitioning exactly once under duplicate, concurrent, late and forged delivery — proven by tests that fail against naive implementations.

**Architecture:** One new feature module (`payments`) holding a four-member `PaymentProvider` port with two DI-selected adapters (`StripePaymentProvider`, `FakePaymentProvider`). Initiation runs with **zero transactions** — an autocommit read, a provider call outside any transaction, a conditional `createMany` insert. The webhook verifies its signature **outside** the transaction, then applies state inside one short `ReadCommitted` transaction: event dedupe via `createMany({ skipDuplicates: true })`, amount/currency check against the persisted order, payment promotion, and `OrdersService.markPaid()`'s `status: PENDING` compare-and-swap. `OrdersModule` keeps sole ownership of `orders` writes.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL 16), Jest (unit + e2e against dockerized Postgres on 5433), Swagger. **Exactly one new runtime dependency: `stripe@22.6.2`.**

**Spec:** `docs/superpowers/specs/2026-09-23-phase-4-payments-design.md` — read it before starting. Every "why" lives there; this plan is the "how". Section references below (§7.3, D11, C3…) point into that spec. The spec is the source of truth; **if this plan and the spec disagree, stop and report it — do not pick one.**

## Global Constraints

- **Exactly one new dependency: `stripe@22.6.2`.** Nothing from Phase 5: no Redis, no BullMQ, no scheduled or background job, no order expiry, no stock-release job, no `payment_events` purge, no automated reconciliation sweep.
- **D11 — payment completion is out-of-band.** No confirm route, no `confirmPayment` provider method, no frontend, no demo-convenience API. The backend creates/reuses the intent and returns `clientSecret`; a provider test tool completes it; the **webhook** is the only path to `PAID` (§7.5).
- **No provider call may occur inside a Prisma transaction.** `PaymentProvider` methods deliberately take no `Prisma.TransactionClient` — the absence is the type-level guarantee (§6.2). A structural test enforces it (Task 5).
- **Prisma errors are never caught in a service or controller.** Dedupe uses `createMany({ skipDuplicates: true })` and reads `{ count }`; there is no `try/catch (P2002)` anywhere (C1). `HttpExceptionFilter` is **not modified** in Phase 4.
- **`createMany({ skipDuplicates: true })` skips on *any* unique conflict.** `payment_events` has one unique column so `count === 0` is unambiguous; `payments` has **two** (`orderId`, `providerPaymentId`) so `count` alone must never be trusted — always read the row back and compare `providerPaymentId` (§11.5).
- **Money is integer minor units, read from the persisted order.** Amount is `order.totalCents`; currency is `order.currency`. Never from the client, never from a request body, never from the provider's word alone.
- **Currency case is normalised only in the adapter** — lowercase outbound, uppercase inbound. The domain never sees a lowercase currency (C8).
- **`src/config/` stays the only reader of `process.env`**; `test/` is the only other exception. Phase 4 adds exactly three variables: `PAYMENT_PROVIDER`, `PAYMENT_API_KEY`, `PAYMENT_WEBHOOK_SECRET` (D7), added to `.env.example` **and** the Joi schema **in the same commit**.
- **Phase 3 checkout is not modified.** `src/modules/orders/checkout.service.ts` gains zero lines. `OrdersService.cancel()`'s CAS predicate (`status: PENDING`) is not modified; only its `count === 0` branch gains a `PAID → 409` split.
- **`OrdersModule` owns every `orders` write** (D9). `PaymentsModule` never writes the `orders` table directly.
- **Transactional service methods take `tx: Prisma.TransactionClient` as a required first parameter, no default** — `markPaid(tx, orderId)` follows `decrementStock(tx, …)`.
- Controllers never return Prisma objects; every response goes through a DTO with a static `from()`.
- Every route gets `@ApiTags`, `@ApiOperation`, `@ApiResponse`.
- **`@Throttle()`'s key must be `default`** — any other key is silently ignored.
- **`maxWorkers: 1` in `test/jest-e2e.json` stays.** Never raise it.
- Test factories insert through the Prisma client, never `$executeRaw` (ids are client-side `uuid(7)`).
- **Typed e2e response bodies.** `recommendedTypeChecked` is on, so `response.body` is `any` and reading a field off it trips `@typescript-eslint/no-unsafe-member-access` (and passing it to `expect()` trips `no-unsafe-argument`) under `npm run lint:ci`. Every existing e2e suite declares a body interface and casts once — do the same. Never fix this with an eslint-disable.
- **Typed Jest mocks.** A bare `jest.Mock` is `Mock<any, any, any>` and trips `@typescript-eslint/no-unsafe-member-access` under `npm run lint:ci` the moment a test reads `.mock.calls[0][0]`. Declare `jest.Mock<TReturn, TArgs>` and construct with `jest.fn<TReturn, TArgs>()`. Never fix this with a cast or an eslint-disable.
- **No real provider credentials anywhere in CI.** CI runs `PAYMENT_PROVIDER=fake`. No live-network test is added to any CI job.
- **Gate for every task:** `npm run lint:ci` (not `npm run lint` — `--fix` hides the failure), `npm run build`, `npm test`, and `npm run test:e2e`. All four green before the task's commit.
- **Commit at the end of each task, exactly once**, with the message given in that task. Do not push. Never amend, rebase, squash, reset, force-push, or rewrite history. Do not commit anything outside the task's file list (the untracked `bash.exe.stackdump` stays untracked).

## Pinned external facts (verified 2026-09-23 — do not re-derive)

| Fact | Value |
|---|---|
| Stripe SDK | `stripe@22.6.2` |
| Pinned API version | `2026-08-26.dahlia` — the SDK types `apiVersion?: LatestApiVersion`, so **no other string compiles** |
| Signature verification | `stripe.webhooks.constructEvent(payload, header, secret, tolerance?)` |
| Offline signature fixtures | `stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp? })` |
| Per-request idempotency key | second argument: `{ idempotencyKey }` |
| USD payable range (spec §5.4.1) | `min 50`, `max 99_999_999` minor units — the **lowest** documented tier, because the payment method is unknown at initiation |
| Every non-USD currency in Phase 4 | `amountLimits()` returns `null` → 422 |

## Decision traceability

Every approved decision, the task that implements it, and the artefact that
proves it. An executor working a single task can find its governing decisions
here without re-reading the spec.

| # | Decision | Task | Where it lands | What proves it |
|---|---|---|---|---|
| **D1** | `Payment` 1:1 with `Order` | 1 | `prisma/schema.prisma` — `Payment.orderId @unique` | migration review (T1 S3); `payment.count === 1` in P3/I1 |
| **D2** | `PaymentStatus { PENDING, SUCCEEDED }` | 1 | `prisma/schema.prisma` | no third value exists; webhook e2e asserts both states |
| **D3** | `rawBody` via one shared `NEST_APP_OPTIONS` seam | 1 | `src/bootstrap.ts`, `src/main.ts`, `test/helpers/create-test-app.ts` | `test/raw-body.e2e-spec.ts` (T1); the raw-body regression (T6) |
| **D4** | Only `payment_intent.succeeded` acts | 6 | `SUPPORTED_EVENT_TYPE` check in the webhook controller | unsupported type → 200, **zero** `payment_events` rows |
| **D5** | `PENDING` cancellation never blocked | 4 | `OrdersService.cancel` CAS predicate **unchanged** | P2 (both legal outcomes); `cancel` unit tests |
| **D6** | `POST /api/v1/payments/webhook` | 6 | `payments-webhook.controller.ts` | route inventory (T10 S3); e2e path |
| **D7** | `PAYMENT_PROVIDER` / `_API_KEY` / `_WEBHOOK_SECRET`; fake banned in prod | 1 | `src/config/env.validation.ts`, `configuration.ts` | `env.validation.spec.ts` production case |
| **D8** | `@Throttle({ default: { ttl: 60_000, limit: 300 } })` | 6 | webhook controller decorator | key is `default`; reviewed in T10 |
| **D9** | `OrdersModule` owns `orders` writes; exports `markPaid(tx, …)` | 4 | `orders.service.ts`, `orders.module.ts` | `grep -rn "OrderStatus.PAID" src/` returns one writer (T10 S2) |
| **D10** | Stripe API version pinned, compiler-enforced | 3 | `STRIPE_API_VERSION` in the adapter | T3 S2 runtime check; SDK type rejects any other string |
| **D11** | Completion is out-of-band; no confirm path | 5, 6, 9 | *absence* of a route/method + README flow | `grep -rni "confirm" src/` (T10 S2); exactly two new routes |
| **C3** | Idempotency retention → local row is the guarantee | 2, 5 | `retrievePayment`; `payment.findUnique` short-circuit | **I1** + its negative control |
| **C4** | Provider amount limits → 422 before any call | 2, 5 | `AMOUNT_LIMITS`, `amountLimitsFor`, the pre-flight check | **A1** + its negative control |

## File map

| File | Responsibility | Task |
|---|---|---|
| `prisma/schema.prisma` | `OrderStatus.PAID`, `PaymentStatus`, `Payment`, `PaymentEvent`, `Order.payment` back-relation | 1 |
| `prisma/migrations/<ts>_phase4_payments/migration.sql` | generated, reviewed, never edited after apply | 1 |
| `src/bootstrap.ts` | **`NEST_APP_OPTIONS`** construction seam (D3); `configureApp()` unchanged | 1 |
| `src/main.ts` | consumes `NEST_APP_OPTIONS` | 1 |
| `test/helpers/create-test-app.ts` | consumes `NEST_APP_OPTIONS` | 1 |
| `src/config/configuration.ts`, `src/config/env.validation.ts` | `payments` config section, three env vars, production fake guard | 1 |
| `.env.example`, `.github/workflows/ci.yml` | new vars in every job that boots the app | 1 |
| `test/helpers/assert-stock-conserved.ts` | count `PAID` orders as holding stock | 1 |
| `test/factories/payment.factory.ts`, `test/factories/payment-event.factory.ts` | new factories | 1 |
| `test/fixtures/raw-body-probe.module.ts` | proves `req.rawBody` is a `Buffer` before any webhook exists | 1 |
| `src/modules/payments/provider/payment-provider.ts` | interface, DI token, normalised types, `AMOUNT_LIMITS` | 2 |
| `src/modules/payments/provider/fake-payment.provider.ts` | deterministic adapter | 2 |
| `src/modules/payments/payments.module.ts` | DI selection by config | 2 |
| `src/modules/payments/provider/stripe-payment.provider.ts` | thin real adapter | 3 |
| `src/modules/orders/orders.service.ts` | `markPaid(tx, orderId)`; `cancel()` PAID → 409 | 4 |
| `src/modules/orders/orders.module.ts` | exports `OrdersService` | 4 |
| `src/modules/payments/payments.service.ts` | initiation (§7.3) | 5 |
| `src/modules/payments/payments.controller.ts` | `POST /orders/:id/payments` | 5 |
| `src/modules/payments/dto/payment-response.dto.ts` | response mapper | 5 |
| `src/modules/payments/payments-webhook.controller.ts` | `POST /payments/webhook`, `@Public()`, `@Throttle`, raw body | 6 |
| `src/modules/payments/payment-webhook.service.ts` | the webhook transaction (§8.2) | 7 |
| `test/payments-concurrency.e2e-spec.ts` | P1–P4, I1, A1 + negative controls | 8 |
| `CLAUDE.md`, `README.md`, `docs/deferred-limitations.md`, the spec's §19 | documentation and evidence | 9 |

## Task dependency order

```
1 (schema + config + rawBody seam + test harness)
│
├── 2 (provider port + fake) ── 3 (stripe adapter + DI wiring)
│                                    │
└── 4 (markPaid + PAID-aware cancel) │
     │                               │
     │                 ┌─────────────┴─────────────┐
     │                 5 (initiation)   6 (webhook controller)
     │                 │                │
     └─────────────────│────────────────7 (webhook state application) [needs 4, 6]
                       │                │
                       └────────┬───────┘
                                8 (concurrency + negative controls) [needs 5, 7]
                                     └── 9 (documentation + evidence)
                                              └── 10 (closeout review)
```

**Parallelisable:** `2 → 3` and `4` are two independent branches off Task 1 and may run concurrently. `5` and `6` are independent of each other once `3` lands. Nothing else may overlap.

**Two refinements to the suggested decomposition, both forced by the repository:**

1. **`OrdersService.markPaid` is its own task (4), not folded into initiation.** It is an `orders`-module change deserving an `orders`-module reviewer gate; it is a prerequisite of the **webhook** (Task 7), not of initiation (Task 5); and bundling it would serialise two genuinely independent branches.
2. **Task 3 depends on Task 2 — they are not parallel.** The brief allowed partial parallelism, but `StripePaymentProvider` imports the port's types and `amountLimitsFor()`, which Task 2 defines. Putting the DI factory in Task 3 (the first task where *both* adapters exist) also avoids shipping a temporary `throw` stub for the unwired branch.

**Hard orderings that break silently:**
- Task 1's migration is **frozen once applied**. No later task edits `prisma/schema.prisma` or anything under `prisma/migrations/`. If a later task appears to need a schema change, **stop and report** — do not add a second migration.
- Task 1 must land the CI env vars. Adding a required env var without updating **both** the `e2e` and the `bootstrap` CI jobs turns every later task's CI run red for an unrelated reason (see Task 1 Step 9).
- Task 1 must land the `assert-stock-conserved` change. Without it, every Phase 4 test that reaches `PAID` fails a conservation assertion that is not actually violated (see Task 1 Step 7).
- Task 8 cannot start before 5 and 7: a negative control needs a real implementation to revert to.
- Task 6 proves the **raw-body signature boundary**; Task 1 proves the **seam** that makes it possible. Task 6 without Task 1 silently cannot verify anything.

### Coverage type per task

| Task | Unit | Deterministic e2e | Concurrency e2e |
|---|---|---|---|
| 1 | config + Joi schema | factories, raw-body probe | — |
| 2 | `FakePaymentProvider`, DI selection | — | — |
| 3 | `StripePaymentProvider` (offline signatures) | — | — |
| 4 | `OrdersService.markPaid`, `cancel` | cancel a `PAID` order → 409 | — |
| 5 | `PaymentsService` + structural no-I/O guard | initiation matrix | — |
| 6 | webhook signature/classification | signature + raw-body regression | — |
| 7 | `PaymentWebhookService` branches | webhook state matrix | — |
| 8 | — | — | **P1–P4, I1, A1 + negative controls** |
| 9 | — | — | — |
| 10 | — | full gate re-run | re-run ×3 |

---

## Task 1: Schema, migration, configuration, and the raw-body construction seam

**Objective:** Land every foundation Phase 4 needs — the two models, the additive enum value, the three env vars, the `NEST_APP_OPTIONS` seam (D3), and the two test-harness changes that would otherwise produce misleading failures in every later task. No payment logic.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_phase4_payments/migration.sql` (generated; reviewed, not edited)
- Modify: `src/bootstrap.ts`, `src/main.ts`, `test/helpers/create-test-app.ts`
- Modify: `src/config/configuration.ts`, `src/config/env.validation.ts`
- Modify: `src/config/configuration.spec.ts`, `src/config/env.validation.spec.ts`
- Modify: `.env.example`, `.github/workflows/ci.yml`
- Modify: `test/helpers/assert-stock-conserved.ts`
- Create: `test/factories/payment.factory.ts`, `test/factories/payment-event.factory.ts`
- Create: `test/fixtures/raw-body-probe.module.ts`
- Test: `test/factories.e2e-spec.ts` (append), `test/raw-body.e2e-spec.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma enum `PaymentStatus { PENDING, SUCCEEDED }`; `OrderStatus` gains `PAID`; models `Payment`, `PaymentEvent`; `NEST_APP_OPTIONS: NestApplicationOptions` exported from `src/bootstrap.ts`; `AppConfig['payments'] = { provider: 'stripe' | 'fake'; apiKey: string | undefined; webhookSecret: string }`; factories `createPayment(prisma, orderId, overrides?): Promise<Payment>` and `createPaymentEvent(prisma, providerEventId, overrides?): Promise<PaymentEvent>`.

**What must NOT be changed in this task:** `src/modules/**` (no service or controller yet), `configureApp()`'s body, `HttpExceptionFilter`, `test/jest-e2e.json`, `docker-compose.yml`, `Dockerfile`.

- [ ] **Step 1: Add the enum value and the two models to `prisma/schema.prisma`**

Change the existing enum in place:

```prisma
enum OrderStatus {
  PENDING
  CANCELLED
  PAID
}
```

Add a new enum directly below it:

```prisma
enum PaymentStatus {
  PENDING
  SUCCEEDED
}
```

Add one field to `model Order` (a relation field, **not** a column) directly after `cancelledAt`:

```prisma
  payment        Payment?
```

Append the two new models at the end of the file:

```prisma
model Payment {
  id                String        @id @default(uuid(7))
  orderId           String        @unique @map("order_id")
  order             Order         @relation(fields: [orderId], references: [id], onDelete: Restrict)
  providerPaymentId String        @unique @map("provider_payment_id")
  status            PaymentStatus @default(PENDING)
  succeededAt       DateTime?     @map("succeeded_at")
  createdAt         DateTime      @default(now()) @map("created_at")
  updatedAt         DateTime      @updatedAt @map("updated_at")

  @@map("payments")
}

model PaymentEvent {
  id              String   @id @default(uuid(7))
  providerEventId String   @unique @map("provider_event_id")
  type            String
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@map("payment_events")
}
```

**Do not add any other field.** Spec §11.2/§11.3 enumerate what is omitted and why: no `amountCents`, no `currency`, no `clientSecret`, no `provider`, no `attemptCount`, no `rawProviderPayload`, no `idempotencyKey` on `Payment`; no `receivedAt`, no `payload`, no `orderId` FK, no `processedAt`/`status` on `PaymentEvent`.

**No `@@index` beyond the two `@@unique` constraints.** They create every index Phase 4 queries need.

- [ ] **Step 2: Generate the migration**

```bash
docker compose up -d postgres
npx prisma migrate dev --name phase4_payments
```

- [ ] **Step 3: Review the generated SQL — do not edit it**

Open `prisma/migrations/<timestamp>_phase4_payments/migration.sql` and confirm all four:

1. It contains `ALTER TYPE "OrderStatus" ADD VALUE 'PAID';`
2. It contains `CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED');`
3. It creates `payments` and `payment_events` with the unique indexes `payments_order_id_key`, `payments_provider_payment_id_key`, `payment_events_provider_event_id_key`, and the FK `payments_order_id_fkey … ON DELETE RESTRICT`.
4. **The literal string `'PAID'` appears exactly once — in the `ALTER TYPE` line.** PostgreSQL forbids *using* a newly added enum value in the transaction that added it, and Prisma wraps each migration file in a transaction. Neither new table references `OrderStatus`, so nothing uses it (§11.1).

If `'PAID'` appears anywhere else — a default, a backfill, a check — **stop**: the migration must be split into two files, and that is a design question for the spec owner.

Unlike Phase 3, this migration needs **no hand-edits**. Phase 4 adds no `CHECK` constraint: `Payment.status` is an enum (the type is the constraint) and there is no numeric column to bound.

- [ ] **Step 4: Prove the migration applies to a fresh database**

```bash
docker compose down -v postgres-test && docker compose up -d postgres-test
npx prisma migrate reset --force --skip-seed
npx prisma migrate deploy
```

Expected: every migration applies in order, ending with `phase4_payments`, with no error. A failure here is almost certainly the enum-in-transaction problem from Step 3.

- [ ] **Step 5: Add the `NEST_APP_OPTIONS` construction seam (D3, resolves C2)**

In `src/bootstrap.ts`, add the import and the exported constant **above** `configureApp`:

```ts
import {
  INestApplication,
  NestApplicationOptions,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
```

```ts
/**
 * Construction options, as distinct from configuration.
 *
 * `rawBody` is a NestFactory *create* option, not something `configureApp()`
 * can set — but it is consumed by two different factories (`main.ts` uses
 * `NestFactory.create`, the e2e harness uses
 * `TestingModule#createNestApplication`). Writing `{ rawBody: true }` at both
 * call sites by hand is exactly the runtime/e2e divergence `configureApp()`
 * exists to prevent: one side silently loses webhook signature verification
 * while the other stays green.
 *
 * So: one definition, two consumers. `configureApp()` below remains the single
 * CONFIGURATION seam; this constant is the single CONSTRUCTION seam. They live
 * in the same file so the pairing cannot be missed.
 *
 * Why raw bytes at all: the payment webhook's signature is an HMAC over the
 * exact bytes the provider sent. `JSON.parse` then `JSON.stringify` does not
 * reproduce them (key order, whitespace, unicode escaping), so verification
 * against a re-serialised body fails for every authentic event. Route-local
 * `express.raw()` middleware is deliberately NOT used (spec §5.2).
 */
export const NEST_APP_OPTIONS: NestApplicationOptions = { rawBody: true };
```

**Do not change anything inside `configureApp()`.**

- [ ] **Step 6: Consume the seam at both call sites**

In `src/main.ts`:

```ts
import { configureApp, NEST_APP_OPTIONS } from './bootstrap';
```

```ts
  const app = await NestFactory.create(AppModule, NEST_APP_OPTIONS);
```

In `test/helpers/create-test-app.ts`:

```ts
import { configureApp, NEST_APP_OPTIONS } from '../../src/bootstrap';
```

```ts
  const app = moduleFixture.createNestApplication<INestApplication<App>>(
    NEST_APP_OPTIONS,
  );
```

- [ ] **Step 7: Teach `assertStockConserved` that a PAID order still holds its stock**

This is **required**, not cosmetic. `test/helpers/assert-stock-conserved.ts` currently sums held quantity across `status: PENDING` orders only. Once an order reaches `PAID` its stock is still decremented — checkout took it and nothing restores it — but the order drops out of that sum, so `stockQuantity + held` comes up short and the helper fails an invariant that was never violated. Every later task that pays an order and asserts conservation would fail for a false reason.

In `test/helpers/assert-stock-conserved.ts`, change the aggregate's `where` and extend the doc comment:

```ts
  // PAID orders hold their stock exactly as PENDING ones do: checkout
  // decremented it and nothing ever restores it, because Phase 4 does not
  // cancel a paid order (spec §4.3). Only CANCELLED orders drop out of the
  // sum, because their stock went back to the product. Omitting PAID here
  // makes every paid-order test fail an invariant that is not broken.
  const reserved = await prisma.orderItem.aggregate({
    where: {
      productId,
      order: { status: { in: [OrderStatus.PENDING, OrderStatus.PAID] } },
    },
    _sum: { quantity: true },
  });
```

- [ ] **Step 8: Add the three environment variables**

In `src/config/configuration.ts`, extend the `AppConfig` interface:

```ts
  payments: {
    provider: 'stripe' | 'fake';
    apiKey: string | undefined;
    webhookSecret: string;
  };
```

and the factory, after the `admin` block:

```ts
  payments: {
    // Joi has already restricted this to 'stripe' | 'fake' and forbidden
    // 'fake' under NODE_ENV=production. The cast records that; it does not
    // create the guarantee.
    provider: (process.env.PAYMENT_PROVIDER ?? 'fake') as 'stripe' | 'fake',
    // Only the Stripe adapter needs it; Joi requires it when provider=stripe.
    apiKey: process.env.PAYMENT_API_KEY,
    // Same class of value as JWT_SECRET, so it uses the same helper for the
    // same reason: an empty HMAC key does not fail loudly, it verifies
    // happily, and anyone who guesses it can forge paid-order events.
    webhookSecret: requireEnv('PAYMENT_WEBHOOK_SECRET'),
  },
```

In `src/config/env.validation.ts`, add to the schema:

```ts
  // Required with no default: a fake provider silently marking orders paid in
  // production is the worst realistic misconfiguration in this phase, so the
  // choice is always explicit. Under NODE_ENV=production only 'stripe' is
  // accepted, and boot ABORTS otherwise — enforced here, not by convention.
  PAYMENT_PROVIDER: Joi.string()
    .valid('stripe', 'fake')
    .required()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.valid('stripe'),
    }),
  PAYMENT_API_KEY: Joi.string().when('PAYMENT_PROVIDER', {
    is: 'stripe',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  PAYMENT_WEBHOOK_SECRET: Joi.string().min(16).required(),
```

In `.env.example`, append:

```
# Payments (Phase 4)
# PAYMENT_PROVIDER selects the adapter: `stripe` or `fake`.
# `fake` is a real, DI-selected implementation for local development and the
# e2e suite. Boot ABORTS if it is used with NODE_ENV=production.
PAYMENT_PROVIDER=fake
# Required only when PAYMENT_PROVIDER=stripe. Use a test-mode key.
PAYMENT_API_KEY=
# Webhook HMAC secret, used by whichever adapter is selected. At least 16
# characters; boot aborts if it is missing or empty.
PAYMENT_WEBHOOK_SECRET=change-me-to-a-random-webhook-signing-secret
```

- [ ] **Step 9: Add the variables to every CI job that boots the application**

Two jobs boot the app and will now fail Joi validation without these. **Both must change, or every later task's CI is red for an unrelated reason.**

In `.github/workflows/ci.yml`, in the **`e2e`** job's `env:` block:

```yaml
      # Phase 4: the app boots with Joi validation in every e2e suite. `fake`
      # is the DI-selected provider for CI — no Stripe credentials exist here
      # and none are needed. PAYMENT_API_KEY is deliberately unset.
      PAYMENT_PROVIDER: fake
      PAYMENT_WEBHOOK_SECRET: ci-only-webhook-secret-not-used-outside-ci
```

In the **`bootstrap`** job's `env:` block, the same two lines. `node dist/scripts/bootstrap-admin.js` boots the full `AppModule` (see `src/scripts/bootstrap-admin.ts`), so Joi validation and `configuration()` both run there too.

The **`build`** job (lint/build/unit) needs nothing: unit tests construct services directly and set `process.env` themselves.

- [ ] **Step 10: Write the failing config unit tests**

Append to `src/config/configuration.spec.ts`:

```ts
  it('maps the payments section from the environment', () => {
    process.env.JWT_SECRET = 'c'.repeat(32);
    process.env.PAYMENT_PROVIDER = 'stripe';
    process.env.PAYMENT_API_KEY = 'sk_test_example';
    process.env.PAYMENT_WEBHOOK_SECRET = 'w'.repeat(20);

    const config = configuration();

    expect(config.payments.provider).toBe('stripe');
    expect(config.payments.apiKey).toBe('sk_test_example');
    expect(config.payments.webhookSecret).toBe('w'.repeat(20));
  });

  it('refuses to start when PAYMENT_WEBHOOK_SECRET is missing', () => {
    process.env.JWT_SECRET = 'd'.repeat(32);
    process.env.PAYMENT_PROVIDER = 'fake';
    delete process.env.PAYMENT_WEBHOOK_SECRET;

    expect(() => configuration()).toThrow(/PAYMENT_WEBHOOK_SECRET/);
  });
```

Append to `src/config/env.validation.spec.ts`. Note `validEnv()` must now supply the two required variables — update the helper itself so every existing test keeps passing:

```ts
function validEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/ecommerce_dev',
    JWT_SECRET: 'x'.repeat(32),
    PAYMENT_PROVIDER: 'fake',
    PAYMENT_WEBHOOK_SECRET: 'y'.repeat(20),
    ...overrides,
  };
}
```

```ts
describe('payments configuration', () => {
  it('rejects a missing PAYMENT_PROVIDER — there is no default', () => {
    const env = validEnv();
    delete env.PAYMENT_PROVIDER;

    expect(validate(env).error?.message).toContain('PAYMENT_PROVIDER');
  });

  it('rejects an unknown provider name', () => {
    expect(
      validate(validEnv({ PAYMENT_PROVIDER: 'paypal' })).error?.message,
    ).toContain('PAYMENT_PROVIDER');
  });

  it('rejects the fake provider under NODE_ENV=production', () => {
    const { error } = validate(
      validEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'fake' }),
    );

    expect(error?.message).toContain('PAYMENT_PROVIDER');
  });

  it('accepts the stripe provider under NODE_ENV=production when a key is set', () => {
    const { error } = validate(
      validEnv({
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'stripe',
        PAYMENT_API_KEY: 'sk_test_example',
      }),
    );

    expect(error).toBeUndefined();
  });

  it('requires PAYMENT_API_KEY when the provider is stripe', () => {
    const { error } = validate(validEnv({ PAYMENT_PROVIDER: 'stripe' }));

    expect(error?.message).toContain('PAYMENT_API_KEY');
  });

  it('does not require PAYMENT_API_KEY when the provider is fake', () => {
    expect(validate(validEnv()).error).toBeUndefined();
  });

  it('rejects a missing or too-short PAYMENT_WEBHOOK_SECRET', () => {
    const missing = validEnv();
    delete missing.PAYMENT_WEBHOOK_SECRET;

    expect(validate(missing).error?.message).toContain(
      'PAYMENT_WEBHOOK_SECRET',
    );
    expect(
      validate(validEnv({ PAYMENT_WEBHOOK_SECRET: 'short' })).error?.message,
    ).toContain('PAYMENT_WEBHOOK_SECRET');
  });
});
```

- [ ] **Step 11: Run the config unit tests and watch them fail**

Run: `npx jest src/config --silent`
Expected: FAIL — `payments` is not on `AppConfig`, and the Joi keys do not exist yet. (If you wrote Step 8 before Step 10, re-order: the test must be seen failing.)

- [ ] **Step 12: Run them again and watch them pass**

Run: `npx jest src/config --silent`
Expected: PASS, including every pre-existing config test.

- [ ] **Step 13: Write the two factories**

Create `test/factories/payment.factory.ts`:

```ts
import { Payment, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Same serial-suite caveat as the other factories. */
let sequence = 0;

/**
 * Builds a Payment row directly, bypassing initiation. Use it for read and
 * replay tests.
 *
 * NEVER use it to set an order to PAID for a webhook test: the webhook suite
 * must reach PAID through a signed event, or it proves nothing about the
 * pipeline it exists to test (spec §15.2).
 */
export async function createPayment(
  prisma: PrismaService,
  orderId: string,
  overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
): Promise<Payment> {
  sequence += 1;

  return prisma.payment.create({
    data: {
      orderId,
      providerPaymentId: `factory_pi_${sequence}`,
      status: PaymentStatus.PENDING,
      ...overrides,
    },
  });
}
```

Create `test/factories/payment-event.factory.ts`:

```ts
import { PaymentEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

let sequence = 0;

/** Builds a PaymentEvent row directly, for dedupe-precondition tests. */
export async function createPaymentEvent(
  prisma: PrismaService,
  providerEventId?: string,
  overrides: Partial<Prisma.PaymentEventUncheckedCreateInput> = {},
): Promise<PaymentEvent> {
  sequence += 1;

  return prisma.paymentEvent.create({
    data: {
      providerEventId: providerEventId ?? `factory_evt_${sequence}`,
      type: 'payment_intent.succeeded',
      ...overrides,
    },
  });
}
```

- [ ] **Step 14: Write the raw-body probe fixture**

Create `test/fixtures/raw-body-probe.module.ts`. This proves the **seam** (D3) end-to-end before any webhook route exists — if `NEST_APP_OPTIONS` is ever dropped from `create-test-app.ts`, this fails immediately instead of a webhook suite failing for an apparently unrelated signature reason.

```ts
import { Controller, Module, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../src/common/decorators/public.decorator';

interface RawBodyProbeResult {
  isBuffer: boolean;
  raw: string | null;
  parsedIsObject: boolean;
}

@Controller('raw-body-probe')
class RawBodyProbeController {
  @Public()
  @Post()
  probe(@Req() request: RawBodyRequest<Request>): RawBodyProbeResult {
    const raw = request.rawBody;

    return {
      isBuffer: Buffer.isBuffer(raw),
      raw: Buffer.isBuffer(raw) ? raw.toString('utf8') : null,
      parsedIsObject: typeof request.body === 'object' && request.body !== null,
    };
  }
}

@Module({ controllers: [RawBodyProbeController] })
export class RawBodyProbeModule {}
```

- [ ] **Step 15: Write the failing raw-body e2e test**

Create `test/raw-body.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { RawBodyProbeModule } from './fixtures/raw-body-probe.module';

describe('Raw body construction seam (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp([RawBodyProbeModule], { throttleLimit: 0 });
  });

  afterAll(async () => {
    await app.close();
  });

  // Byte-exactness is the whole point: this payload survives JSON.parse but
  // NOT a parse/re-stringify round trip, because the key order and the
  // spacing both change. A webhook HMAC over a re-serialised body would fail
  // for every authentic event.
  const PAYLOAD = '{"b":1,  "a":"\\u00e9"}';

  it('exposes request.rawBody as a Buffer holding the exact bytes sent', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/raw-body-probe')
      .set('Content-Type', 'application/json')
      .send(PAYLOAD)
      .expect(201);

    expect(response.body.isBuffer).toBe(true);
    expect(response.body.raw).toBe(PAYLOAD);
  });

  it('still parses the body normally, so every other route is unaffected', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/raw-body-probe')
      .set('Content-Type', 'application/json')
      .send(PAYLOAD)
      .expect(201);

    expect(response.body.parsedIsObject).toBe(true);
  });
});
```

- [ ] **Step 16: Append factory coverage to `test/factories.e2e-spec.ts`**

Follow the file's existing style. Add a `describe` that creates a user, category, product and order via the existing factories, then:

```ts
    const payment = await createPayment(prisma, order.id);

    expect(payment.orderId).toBe(order.id);
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.succeededAt).toBeNull();
    expect(payment.id).toMatch(/^[0-9a-f-]{36}$/);

    const event = await createPaymentEvent(prisma);

    expect(event.type).toBe('payment_intent.succeeded');
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
```

The id assertions matter: `@default(uuid(7))` is generated **client-side** by Prisma, so a factory that used `$executeRaw` would produce a row with no id. This is the same check the Phase 3 factories carry.

- [ ] **Step 17: Run the e2e suite**

```bash
docker compose up -d postgres-test
npm run test:e2e
```

Expected: PASS, including `raw-body.e2e-spec.ts` and every pre-existing suite. If `raw-body.e2e-spec.ts` reports `isBuffer: false`, `NEST_APP_OPTIONS` is not reaching `createNestApplication` — fix Step 6 rather than the test.

- [ ] **Step 18: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Expected: all four green.

- [ ] **Step 19: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/bootstrap.ts src/main.ts \
  src/config test/helpers/create-test-app.ts test/helpers/assert-stock-conserved.ts \
  test/factories/payment.factory.ts test/factories/payment-event.factory.ts \
  test/fixtures/raw-body-probe.module.ts test/raw-body.e2e-spec.ts \
  test/factories.e2e-spec.ts .env.example .github/workflows/ci.yml
git commit -m "feat(payments): add payment schema, config, and raw-body construction seam

Adds OrderStatus.PAID, PaymentStatus, Payment and PaymentEvent, plus the
three PAYMENT_* environment variables validated by Joi (fake provider is
rejected under NODE_ENV=production).

rawBody is supplied through one exported NEST_APP_OPTIONS constant in
src/bootstrap.ts, consumed by both main.ts and the e2e harness, so runtime
and test applications cannot diverge. configureApp() is unchanged.

assertStockConserved now counts PAID orders as holding stock: a paid order's
stock is never restored, so omitting it would fail an invariant that is not
broken.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The `PaymentProvider` port and `FakePaymentProvider`

**Objective:** Define the four-member port, its normalised types, the shared amount-limit contract, and the deterministic fake adapter. No DI wiring yet — the fake is unit-tested by direct construction, and the module factory lands in Task 3 where both branches exist.

**Files:**
- Create: `src/modules/payments/provider/payment-provider.ts`
- Create: `src/modules/payments/provider/fake-payment.provider.ts`
- Create: `src/modules/payments/provider/fake-payment.provider.spec.ts`

**Interfaces:**
- Consumes: `AppConfig['payments']` (Task 1).
- Produces: `PAYMENT_PROVIDER` (DI token, a `Symbol`); `interface PaymentProvider`; types `CreatePaymentInput`, `ProviderPayment`, `ProviderEvent`, `AmountLimits`; `SUPPORTED_EVENT_TYPE`; `AMOUNT_LIMITS` and `amountLimitsFor(currency)`; class `FakePaymentProvider` with test controls `reset()`, `signWebhook(payload)`, `createCountFor(key)`, `expireIdempotencyKeys()`, `failNextCreate(message)`.

**What must NOT be changed in this task:** `src/app.module.ts`, anything under `src/modules/orders/`, `prisma/`, any `test/` file.

**Database implications:** none. This task touches no table.

- [ ] **Step 1: Write the port**

Create `src/modules/payments/provider/payment-provider.ts`:

```ts
/**
 * The payment provider port.
 *
 * Four members, each with exactly one caller in Phase 4 (spec §6.2):
 *   createPayment   — initiation, first attempt only
 *   retrievePayment — initiation replay, whenever a Payment row exists
 *   verifyWebhook   — the webhook endpoint's only authentication
 *   amountLimits    — initiation, before createPayment; pure, no I/O
 *
 * Deliberately absent: confirmPayment (D11 — completion is out-of-band),
 * cancelPayment, refund, capture, void, listEvents, getCustomer. None has a
 * caller, and confirmPayment would put a second writer on the paid path
 * beside the webhook.
 *
 * NO METHOD TAKES A Prisma.TransactionClient. That absence is the point: it
 * is the inverse of the decrementStock(tx, …) convention. Where a required
 * `tx` proves a call must run INSIDE a transaction, its absence here
 * documents at the type level that a provider call can never be made from
 * inside one (spec §10).
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** The only event type that changes authoritative order state (D4). */
export const SUPPORTED_EVENT_TYPE = 'payment_intent.succeeded';

export interface CreatePaymentInput {
  orderId: string;
  amountMinorUnits: number;
  currency: string;
  idempotencyKey: string;
}

export interface ProviderPayment {
  providerPaymentId: string;
  clientSecret: string;
  amountMinorUnits: number;
  /** Uppercase ISO-4217. Adapters normalise; the domain never sees lowercase. */
  currency: string;
}

export interface ProviderEvent {
  providerEventId: string;
  type: string;
  providerPaymentId: string;
  orderId: string;
  amountMinorUnits: number;
  /** Uppercase ISO-4217, normalised by the adapter (spec §8.4, C8). */
  currency: string;
}

export interface AmountLimits {
  minMinorUnits: number;
  maxMinorUnits: number;
}

/**
 * The payable range, as a DOMAIN contract rather than an adapter detail —
 * which is why it lives in the port and both adapters return from it. A
 * future provider with different limits makes this per-adapter AT THAT TIME,
 * not speculatively now.
 *
 * Verified against Stripe's published tables on 2026-09-23 (spec §5.4.1,
 * https://docs.stripe.com/currencies -> "Minimum and maximum charge amounts"):
 *
 *   minimum   0.50 USD                                    -> 50
 *   maximum   12 digits for most card networks,
 *              9 digits for American Express,
 *              8 digits for non-card methods              -> 99_999_999
 *
 * The maximum is the LOWEST documented tier on purpose: the payment method is
 * unknown at initiation, so only a value below every tier produces a correct
 * refusal for all of them. The rule for ever changing these numbers: they
 * must stay AT OR INSIDE the provider's published range, never wider — a
 * conservative constant yields a clean 422, a too-wide one yields an opaque
 * provider rejection.
 *
 * A currency absent from this map is not payable in Phase 4 (422).
 */
export const AMOUNT_LIMITS: Readonly<Record<string, AmountLimits>> = {
  USD: { minMinorUnits: 50, maxMinorUnits: 99_999_999 },
};

export function amountLimitsFor(currency: string): AmountLimits | null {
  return AMOUNT_LIMITS[currency] ?? null;
}

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<ProviderPayment>;
  retrievePayment(providerPaymentId: string): Promise<ProviderPayment>;
  /** Throws on an invalid signature or an unusable payload. Never returns null. */
  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent;
  amountLimits(currency: string): AmountLimits | null;
}
```

- [ ] **Step 2: Write the failing fake-provider unit tests**

Create `src/modules/payments/provider/fake-payment.provider.spec.ts`:

```ts
import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../../config/configuration';
import { FakePaymentProvider } from './fake-payment.provider';
import { SUPPORTED_EVENT_TYPE } from './payment-provider';

const SECRET = 'fake-webhook-secret-value';

function configStub(): ConfigService<AppConfig, true> {
  return {
    get: (key: string): unknown =>
      key === 'payments.webhookSecret' ? SECRET : undefined,
  } as unknown as ConfigService<AppConfig, true>;
}

function eventPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type: SUPPORTED_EVENT_TYPE,
    providerPaymentId: 'pi_1',
    orderId: 'order-1',
    amountMinorUnits: 1000,
    currency: 'usd',
    ...overrides,
  });
}

describe('FakePaymentProvider', () => {
  let provider: FakePaymentProvider;

  beforeEach(() => {
    provider = new FakePaymentProvider(configStub());
  });

  const input = {
    orderId: 'order-1',
    amountMinorUnits: 1000,
    currency: 'USD',
    idempotencyKey: 'order-1',
  };

  describe('createPayment', () => {
    it('returns a payment and counts one create for the key', async () => {
      const created = await provider.createPayment(input);

      expect(created.providerPaymentId).toContain('order-1');
      expect(created.clientSecret).toContain(created.providerPaymentId);
      expect(created.amountMinorUnits).toBe(1000);
      expect(created.currency).toBe('USD');
      expect(provider.createCountFor('order-1')).toBe(1);
    });

    it('returns the SAME payment for a repeated idempotency key', async () => {
      const first = await provider.createPayment(input);
      const second = await provider.createPayment(input);

      expect(second.providerPaymentId).toBe(first.providerPaymentId);
      expect(second.clientSecret).toBe(first.clientSecret);
      expect(provider.createCountFor('order-1')).toBe(1);
    });

    // The whole point of C3: key retention is bounded, so the key alone is
    // NOT a durable guarantee. The durable guarantee is the local Payment
    // row, proven end-to-end in test I1.
    it('issues a NEW payment for the same key once retention has expired', async () => {
      const first = await provider.createPayment(input);

      provider.expireIdempotencyKeys();

      const second = await provider.createPayment(input);

      expect(second.providerPaymentId).not.toBe(first.providerPaymentId);
      expect(provider.createCountFor('order-1')).toBe(2);
    });

    it('throws when told to fail, and does not record a create', async () => {
      provider.failNextCreate('simulated provider outage');

      await expect(provider.createPayment(input)).rejects.toThrow(
        'simulated provider outage',
      );
      expect(provider.createCountFor('order-1')).toBe(0);
    });
  });

  describe('retrievePayment', () => {
    it('returns the same payment that was created, without a new create', async () => {
      const created = await provider.createPayment(input);
      const retrieved = await provider.retrievePayment(
        created.providerPaymentId,
      );

      expect(retrieved).toEqual(created);
      expect(provider.createCountFor('order-1')).toBe(1);
    });

    // Retrieval is a lookup by id: retention does not apply to it.
    it('still returns the payment after idempotency-key retention expires', async () => {
      const created = await provider.createPayment(input);

      provider.expireIdempotencyKeys();

      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toEqual(created);
    });

    it('throws for an unknown id', async () => {
      await expect(provider.retrievePayment('pi_missing')).rejects.toThrow();
    });
  });

  describe('verifyWebhook', () => {
    it('accepts a payload signed with the configured secret', () => {
      const payload = eventPayload();
      const event = provider.verifyWebhook(
        Buffer.from(payload),
        provider.signWebhook(payload),
      );

      expect(event.providerEventId).toBe('evt_1');
      expect(event.type).toBe(SUPPORTED_EVENT_TYPE);
      expect(event.orderId).toBe('order-1');
      expect(event.amountMinorUnits).toBe(1000);
    });

    // C8: the wire carries a lowercase code; the domain must never see one.
    it('uppercases the currency on the way in', () => {
      const payload = eventPayload();
      const event = provider.verifyWebhook(
        Buffer.from(payload),
        provider.signWebhook(payload),
      );

      expect(event.currency).toBe('USD');
    });

    it('rejects a tampered body', () => {
      const signature = provider.signWebhook(eventPayload());

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(eventPayload({ amountMinorUnits: 1 })),
          signature,
        ),
      ).toThrow();
    });

    it('rejects a signature made with a different secret', () => {
      const payload = eventPayload();
      const forged = createHmac('sha256', 'not-the-secret')
        .update(payload)
        .digest('hex');

      expect(() =>
        provider.verifyWebhook(Buffer.from(payload), forged),
      ).toThrow();
    });

    it('rejects a missing or malformed signature header', () => {
      const payload = eventPayload();

      expect(() => provider.verifyWebhook(Buffer.from(payload), '')).toThrow();
      expect(() =>
        provider.verifyWebhook(Buffer.from(payload), 'not-hex'),
      ).toThrow();
    });

    it('rejects a correctly signed but unusable payload', () => {
      const payload = '{"id":"evt_2"}';

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(payload),
          provider.signWebhook(payload),
        ),
      ).toThrow();
    });
  });

  describe('amountLimits', () => {
    it('returns the USD range', () => {
      expect(provider.amountLimits('USD')).toEqual({
        minMinorUnits: 50,
        maxMinorUnits: 99_999_999,
      });
    });

    it('returns null for an unsupported currency', () => {
      expect(provider.amountLimits('EUR')).toBeNull();
    });
  });

  it('reset() clears intents, counters and retention', async () => {
    await provider.createPayment(input);
    provider.reset();

    expect(provider.createCountFor('order-1')).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx jest src/modules/payments --silent`
Expected: FAIL — `Cannot find module './fake-payment.provider'`.

- [ ] **Step 4: Write `FakePaymentProvider`**

Create `src/modules/payments/provider/fake-payment.provider.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../../config/configuration';
import {
  AmountLimits,
  CreatePaymentInput,
  PaymentProvider,
  ProviderEvent,
  ProviderPayment,
  amountLimitsFor,
} from './payment-provider';

/**
 * A REAL, DI-selected implementation — not a test double, and not in test/.
 *
 * It exists because CI has no provider credentials, e2e must run offline
 * against real Postgres, and every concurrency claim needs a recorded
 * negative control. Selecting it through configuration means e2e boots the
 * real AppModule with real wiring rather than an overrideProvider() mock —
 * which matters in this repo, where overrideGuard() is documented as a silent
 * no-op against APP_GUARD registrations.
 *
 * It verifies signatures with a CONSTANT-TIME comparison. The fake must not
 * be a weaker verifier than the thing it stands in for, or the e2e suite
 * proves nothing about the shape of the real path.
 *
 * It is never selectable in production: Joi rejects PAYMENT_PROVIDER=fake
 * under NODE_ENV=production at boot (src/config/env.validation.ts).
 *
 * In-memory state is NOT cleared by truncateAll(). Every suite that uses the
 * test controls must call reset() in beforeEach.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  private readonly webhookSecret: string;

  /** providerPaymentId -> the payment, for retrievePayment (never expires). */
  private readonly intents = new Map<string, ProviderPayment>();

  /** idempotencyKey -> providerPaymentId, pruned by expireIdempotencyKeys(). */
  private readonly retention = new Map<string, string>();

  /** idempotencyKey -> how many intents this provider actually created. */
  private readonly createCounts = new Map<string, number>();

  private sequence = 0;
  private nextCreateFailure: string | null = null;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.webhookSecret = configService.get('payments.webhookSecret', {
      infer: true,
    });
  }

  async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    if (this.nextCreateFailure !== null) {
      const message = this.nextCreateFailure;

      this.nextCreateFailure = null;

      // A timeout and an outage are the same thing to every caller: a
      // rejected promise. There is deliberately no separate timeout knob.
      return Promise.reject(new Error(message));
    }

    const existingId = this.retention.get(input.idempotencyKey);

    if (existingId !== undefined) {
      // Within the retention window the provider returns the SAME object —
      // this is what makes concurrent initiation produce exactly one intent.
      return this.intents.get(existingId)!;
    }

    this.sequence += 1;

    const providerPaymentId = `pi_fake_${input.orderId}_${this.sequence}`;
    const payment: ProviderPayment = {
      providerPaymentId,
      clientSecret: `${providerPaymentId}_secret_${this.sequence}`,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
    };

    this.intents.set(providerPaymentId, payment);
    this.retention.set(input.idempotencyKey, providerPaymentId);
    this.createCounts.set(
      input.idempotencyKey,
      (this.createCounts.get(input.idempotencyKey) ?? 0) + 1,
    );

    return payment;
  }

  async retrievePayment(providerPaymentId: string): Promise<ProviderPayment> {
    const payment = this.intents.get(providerPaymentId);

    if (payment === undefined) {
      return Promise.reject(new Error(`Unknown payment ${providerPaymentId}`));
    }

    return payment;
  }

  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent {
    const expected = Buffer.from(this.sign(rawBody), 'utf8');
    const actual = Buffer.from(signature, 'utf8');

    // Length is compared first: timingSafeEqual throws on a length mismatch.
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error('Invalid signature');
    }

    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Malformed event payload');
    }

    const event = parsed as Record<string, unknown>;

    if (
      typeof event.id !== 'string' ||
      typeof event.type !== 'string' ||
      typeof event.providerPaymentId !== 'string' ||
      typeof event.orderId !== 'string' ||
      typeof event.amountMinorUnits !== 'number' ||
      typeof event.currency !== 'string'
    ) {
      throw new Error('Malformed event payload');
    }

    return {
      providerEventId: event.id,
      type: event.type,
      providerPaymentId: event.providerPaymentId,
      orderId: event.orderId,
      amountMinorUnits: event.amountMinorUnits,
      // Normalised here, exactly as the Stripe adapter does (C8).
      currency: event.currency.toUpperCase(),
    };
  }

  amountLimits(currency: string): AmountLimits | null {
    return amountLimitsFor(currency);
  }

  // ---- test controls -------------------------------------------------
  // Deliberately small. The fake simulates the provider BEHAVIOURS the design
  // depends on and nothing else: it is not a Stripe emulator. A mismatched
  // amount, an unknown order or an unsupported event type is expressed by the
  // test signing whatever payload it wants — no provider knob is needed.

  /** Produces a valid signature header for a payload. */
  signWebhook(payload: string): string {
    return this.sign(Buffer.from(payload, 'utf8'));
  }

  /** How many intents were actually created for a key (P3, I1). */
  createCountFor(idempotencyKey: string): number {
    return this.createCounts.get(idempotencyKey) ?? 0;
  }

  /** Simulates the provider pruning its idempotency keys (C3, I1). */
  expireIdempotencyKeys(): void {
    this.retention.clear();
  }

  /** The next createPayment rejects. A timeout is the same to the caller. */
  failNextCreate(message: string): void {
    this.nextCreateFailure = message;
  }

  reset(): void {
    this.intents.clear();
    this.retention.clear();
    this.createCounts.clear();
    this.sequence = 0;
    this.nextCreateFailure = null;
  }

  private sign(rawBody: Buffer): string {
    return createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx jest src/modules/payments --silent`
Expected: PASS, all cases.

- [ ] **Step 6: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Expected: all four green. (No e2e change in this task; the run proves nothing regressed.)

- [ ] **Step 7: Commit**

```bash
git add src/modules/payments/provider
git commit -m "feat(payments): add the PaymentProvider port and FakePaymentProvider

Four members, each with exactly one Phase 4 caller: createPayment,
retrievePayment, verifyWebhook, amountLimits. No method takes a
Prisma.TransactionClient - that absence is the type-level guarantee that a
provider call can never run inside a DB transaction.

The amount-limit contract lives in the port because it is a domain promise,
not an adapter detail. USD is 50..99_999_999 minor units, verified against
Stripe's published tables; the maximum is the lowest documented tier because
the payment method is unknown at initiation.

FakePaymentProvider is a real, config-selected implementation: deterministic
ids, constant-time signature verification, a per-key create counter, and a
switch that simulates the provider pruning its idempotency keys.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: `StripePaymentProvider`, the dependency, and DI selection

**Objective:** Add the one new runtime dependency, implement the thin real adapter with a compiler-enforced API-version pin, and wire provider selection by configuration. This is the first task where both branches of the selection exist, which is why the module lands here rather than in Task 2.

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/modules/payments/provider/stripe-payment.provider.ts`
- Create: `src/modules/payments/provider/stripe-payment.provider.spec.ts`
- Create: `src/modules/payments/payments.module.ts`
- Create: `src/modules/payments/payments.module.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: the port and `FakePaymentProvider` (Task 2); `AppConfig['payments']` (Task 1).
- Produces: `StripePaymentProvider`, `STRIPE_API_VERSION`; `createPaymentProvider(configService)`; `PaymentsModule` exporting the `PAYMENT_PROVIDER` token.

**What must NOT be changed in this task:** the port's shape, `FakePaymentProvider`, anything under `src/modules/orders/`, `prisma/`, and `src/app.module.ts`'s `providers` array (guard registration and its ordering comment are untouched).

**Database implications:** none.

- [ ] **Step 1: Add the dependency at the pinned version**

```bash
npm install stripe@22.6.2 --save-exact
```

Confirm `package.json` shows `"stripe": "22.6.2"` under `dependencies` — exact, no caret. The API-version pin is tied to this SDK version.

- [ ] **Step 2: Confirm the pinned API version from the installed package**

```bash
node -e "console.log(require('stripe/cjs/apiVersion.js').ApiVersion)"
```

Expected output: `2026-08-26.dahlia`

If it prints anything else, **stop and report**. The spec's §6.3 and §19 record this exact string; a mismatch is a spec-versus-reality conflict, not something to paper over.

- [ ] **Step 3: Write the failing Stripe-adapter unit tests**

Create `src/modules/payments/provider/stripe-payment.provider.spec.ts`. These run **offline**: signatures come from the SDK's own `generateTestHeaderString`, so the real verification path is covered with no network and no key.

```ts
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AppConfig } from '../../../config/configuration';
import {
  STRIPE_API_VERSION,
  StripePaymentProvider,
} from './stripe-payment.provider';
import { SUPPORTED_EVENT_TYPE } from './payment-provider';

const SECRET = 'whsec_test_secret';

function configStub(): ConfigService<AppConfig, true> {
  return {
    get: (key: string): unknown => {
      if (key === 'payments.webhookSecret') {
        return SECRET;
      }

      return key === 'payments.apiKey' ? 'sk_test_key' : undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
}

function intentPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_test_1',
    type: SUPPORTED_EVENT_TYPE,
    data: {
      object: {
        id: 'pi_test_1',
        amount: 1000,
        currency: 'usd',
        metadata: { orderId: 'order-1' },
        ...overrides,
      },
    },
  });
}

describe('StripePaymentProvider', () => {
  let provider: StripePaymentProvider;

  beforeEach(() => {
    provider = new StripePaymentProvider(configStub());
  });

  function sign(payload: string, timestamp?: number): string {
    return new Stripe(SECRET).webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
      ...(timestamp === undefined ? {} : { timestamp }),
    });
  }

  // The SDK types apiVersion as `LatestApiVersion = typeof ApiVersion`, so any
  // other string is a COMPILE error. This guards the runtime half: that the
  // constant we pass is the one the installed SDK ships.
  it('pins the API version explicitly', () => {
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
    expect(provider.apiVersion).toBe('2026-08-26.dahlia');
  });

  describe('verifyWebhook', () => {
    it('accepts a correctly signed payload and normalises it', () => {
      const payload = intentPayload();
      const event = provider.verifyWebhook(Buffer.from(payload), sign(payload));

      expect(event.providerEventId).toBe('evt_test_1');
      expect(event.type).toBe(SUPPORTED_EVENT_TYPE);
      expect(event.providerPaymentId).toBe('pi_test_1');
      expect(event.orderId).toBe('order-1');
      expect(event.amountMinorUnits).toBe(1000);
    });

    // C8: Stripe sends `usd`; Order.currency is `USD`. A naive comparison
    // would fail on EVERY authentic event.
    it('uppercases the currency', () => {
      const payload = intentPayload();

      expect(
        provider.verifyWebhook(Buffer.from(payload), sign(payload)).currency,
      ).toBe('USD');
    });

    it('rejects a tampered body', () => {
      const signature = sign(intentPayload());

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(intentPayload({ amount: 1 })),
          signature,
        ),
      ).toThrow();
    });

    it('rejects a signature made with a different secret', () => {
      const payload = intentPayload();
      const forged = new Stripe(
        'whsec_other',
      ).webhooks.generateTestHeaderString({
        payload,
        secret: 'whsec_other',
      });

      expect(() =>
        provider.verifyWebhook(Buffer.from(payload), forged),
      ).toThrow();
    });

    it('rejects a stale timestamp outside the tolerance window', () => {
      const payload = intentPayload();
      const stale = sign(payload, Math.floor(Date.now() / 1000) - 60 * 60 * 24);

      expect(() =>
        provider.verifyWebhook(Buffer.from(payload), stale),
      ).toThrow();
    });

    it('rejects a missing signature header', () => {
      const payload = intentPayload();

      expect(() => provider.verifyWebhook(Buffer.from(payload), '')).toThrow();
    });

    it('rejects a signed event whose payment intent lacks an orderId', () => {
      const payload = intentPayload({ metadata: {} });

      expect(() =>
        provider.verifyWebhook(Buffer.from(payload), sign(payload)),
      ).toThrow();
    });
  });

  describe('amountLimits', () => {
    it('returns the same contract the fake returns', () => {
      expect(provider.amountLimits('USD')).toEqual({
        minMinorUnits: 50,
        maxMinorUnits: 99_999_999,
      });
      expect(provider.amountLimits('EUR')).toBeNull();
    });
  });
});
```

- [ ] **Step 4: Run and watch them fail**

Run: `npx jest src/modules/payments/provider/stripe --silent`
Expected: FAIL — `Cannot find module './stripe-payment.provider'`.

- [ ] **Step 5: Write the Stripe adapter**

Create `src/modules/payments/provider/stripe-payment.provider.ts`. Keep it **thin**: normalise in, normalise out, no business logic.

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AppConfig } from '../../../config/configuration';
import {
  AmountLimits,
  CreatePaymentInput,
  PaymentProvider,
  ProviderEvent,
  ProviderPayment,
  amountLimitsFor,
} from './payment-provider';

/**
 * Pinned explicitly (D10). The SDK types this field as
 * `LatestApiVersion = typeof ApiVersion`, so NO OTHER STRING COMPILES — an SDK
 * upgrade that moves the API version becomes a build error rather than a
 * silent change in event payload shapes.
 *
 * Relying on the Stripe account's default API version is forbidden: that
 * default can be changed from a dashboard by someone who has never seen this
 * repository, and payload shapes would shift under a running deployment.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;

@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly apiVersion = STRIPE_API_VERSION;

  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.webhookSecret = configService.get('payments.webhookSecret', {
      infer: true,
    });
    // Joi requires PAYMENT_API_KEY whenever PAYMENT_PROVIDER=stripe, so this
    // is never undefined on the path that constructs this class.
    this.stripe = new Stripe(
      configService.get('payments.apiKey', { infer: true }) ?? '',
      { apiVersion: STRIPE_API_VERSION },
    );
  }

  async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinorUnits,
        // Stripe expects a lowercase code; the domain holds uppercase (C8).
        currency: input.currency.toLowerCase(),
        // The webhook resolves the order from THIS value, which arrives inside
        // the signed event — never from a local lookup that may not have
        // committed yet (spec §7.4 case 7, S5).
        metadata: { orderId: input.orderId },
      },
      // Deduplicates concurrent creates inside the provider's retention
      // window. Retention is bounded, which is exactly why the local Payment
      // row — not this key — is the durable guarantee (C3).
      { idempotencyKey: input.idempotencyKey },
    );

    return this.toProviderPayment(intent);
  }

  async retrievePayment(providerPaymentId: string): Promise<ProviderPayment> {
    return this.toProviderPayment(
      await this.stripe.paymentIntents.retrieve(providerPaymentId),
    );
  }

  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent {
    // Throws on a bad signature or a timestamp outside the SDK's default
    // tolerance. The tolerance is left at the default: no evidence says it is
    // wrong, and the replay defence does not depend on it.
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );

    const intent = event.data.object as Stripe.PaymentIntent;
    const orderId = intent.metadata?.orderId;

    if (typeof orderId !== 'string' || orderId === '') {
      throw new Error('Event payment intent carries no orderId metadata');
    }

    return {
      providerEventId: event.id,
      type: event.type,
      providerPaymentId: intent.id,
      orderId,
      amountMinorUnits: intent.amount,
      currency: intent.currency.toUpperCase(),
    };
  }

  amountLimits(currency: string): AmountLimits | null {
    return amountLimitsFor(currency);
  }

  private toProviderPayment(intent: Stripe.PaymentIntent): ProviderPayment {
    if (intent.client_secret === null) {
      throw new Error('Payment intent has no client secret');
    }

    return {
      providerPaymentId: intent.id,
      clientSecret: intent.client_secret,
      amountMinorUnits: intent.amount,
      currency: intent.currency.toUpperCase(),
    };
  }
}
```

- [ ] **Step 6: Write the failing provider-selection test**

Create `src/modules/payments/payments.module.spec.ts`. It tests the **factory function**, not Nest's DI container — the behaviour under test is "the configured value selects the adapter".

```ts
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { createPaymentProvider } from './payments.module';
import { FakePaymentProvider } from './provider/fake-payment.provider';
import { StripePaymentProvider } from './provider/stripe-payment.provider';

function configFor(
  values: Record<string, unknown>,
): ConfigService<AppConfig, true> {
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService<AppConfig, true>;
}

describe('createPaymentProvider', () => {
  it('selects the fake adapter when the provider is fake', () => {
    const provider = createPaymentProvider(
      configFor({
        'payments.provider': 'fake',
        'payments.webhookSecret': 'w'.repeat(20),
      }),
    );

    expect(provider).toBeInstanceOf(FakePaymentProvider);
  });

  it('selects the Stripe adapter when the provider is stripe', () => {
    const provider = createPaymentProvider(
      configFor({
        'payments.provider': 'stripe',
        'payments.apiKey': 'sk_test_key',
        'payments.webhookSecret': 'whsec_test',
      }),
    );

    expect(provider).toBeInstanceOf(StripePaymentProvider);
  });
});
```

- [ ] **Step 7: Write `PaymentsModule`**

Create `src/modules/payments/payments.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { PAYMENT_PROVIDER, PaymentProvider } from './provider/payment-provider';
import { FakePaymentProvider } from './provider/fake-payment.provider';
import { StripePaymentProvider } from './provider/stripe-payment.provider';

/**
 * Selection is by configuration, so the e2e suite boots the real AppModule
 * with real wiring rather than an overrideProvider() double.
 *
 * There is deliberately NO second production guard here: Joi already rejects
 * PAYMENT_PROVIDER=fake under NODE_ENV=production at boot
 * (src/config/env.validation.ts), and a duplicated rule is a second place to
 * disagree with the first.
 */
export function createPaymentProvider(
  configService: ConfigService<AppConfig, true>,
): PaymentProvider {
  return configService.get('payments.provider', { infer: true }) === 'stripe'
    ? new StripePaymentProvider(configService)
    : new FakePaymentProvider(configService);
}

@Module({
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: createPaymentProvider,
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
```

- [ ] **Step 8: Register the module**

In `src/app.module.ts`, add the import and append `PaymentsModule` to `imports`, after `OrdersModule`:

```ts
import { PaymentsModule } from './modules/payments/payments.module';
```

**Do not touch the `providers` array.**

- [ ] **Step 9: Run the unit tests and watch them pass**

Run: `npx jest src/modules/payments --silent`
Expected: PASS.

- [ ] **Step 10: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Expected: all four green. The e2e run now boots an `AppModule` that constructs a provider, so it fails loudly if Task 1's `.env`/CI variables were missed.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/modules/payments src/app.module.ts
git commit -m "feat(payments): add StripePaymentProvider and config-driven selection

Adds stripe@22.6.2, the phase's single new runtime dependency, with the API
version pinned to 2026-08-26.dahlia. The SDK types apiVersion as
LatestApiVersion = typeof ApiVersion, so the pin is compiler-enforced: an SDK
upgrade that moves the API version becomes a build error instead of a silent
change in event payload shapes.

The adapter stays thin - it normalises currency case at the boundary in both
directions and carries orderId in PaymentIntent metadata so the webhook can
resolve the order from the signed event rather than from a local row that may
not have committed.

Signature verification is unit-tested offline with the SDK's own
generateTestHeaderString: valid, tampered, wrong-secret, stale-timestamp and
missing-metadata. No live-network test is added to CI.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `OrdersService.markPaid` and PAID-aware cancellation

**Objective:** Give `OrdersModule` the one method that writes `PAID`, and split `cancel()`'s CAS-miss branch so a `PAID` order returns 409 instead of a misleading idempotent 200. `OrdersModule` remains the sole owner of `orders` writes (D9, C6).

**Files:**
- Modify: `src/modules/orders/orders.service.ts`
- Modify: `src/modules/orders/orders.service.spec.ts`
- Modify: `src/modules/orders/orders.module.ts`
- Modify: `src/modules/orders/orders.controller.ts` (Swagger only)
- Test: `test/orders.e2e-spec.ts` (append a `describe`)

**Interfaces:**
- Consumes: `OrderStatus.PAID` (Task 1).
- Produces: `type MarkPaidOutcome = 'paid' | 'already-paid' | 'cancelled' | 'not-found'`; `OrdersService.markPaid(tx: Prisma.TransactionClient, orderId: string): Promise<MarkPaidOutcome>`; `OrdersModule` now exports `OrdersService`.

**What must NOT be changed in this task:** `src/modules/orders/checkout.service.ts` (zero lines), the `status: PENDING` predicate inside `cancel()`'s `updateMany`, `HttpExceptionFilter`, anything under `src/modules/payments/`.

**Database implications:** none — Task 1 already added `PAID`. No migration.

**Why `markPaid` never throws:** a `NotFoundException` here would surface to the **payment provider** as a 404, which most providers read as "stop retrying, this endpoint rejects the event permanently". The same reasoning keeps `ProductsService.describeRefusal()` from reusing `findOne()`. It returns a discriminated outcome instead, and the caller decides the HTTP response — which, for the webhook, is always 200.

- [ ] **Step 1: Write the failing `markPaid` unit tests**

Append to `src/modules/orders/orders.service.spec.ts` (the file already exists with `cancel` coverage; follow its typed-mock style):

```ts
describe('OrdersService.markPaid', () => {
  let service: OrdersService;
  let tx: {
    order: {
      updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    };
  };

  beforeEach(() => {
    tx = {
      order: {
        updateMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
        findUnique: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(null),
      },
    };

    service = new OrdersService(
      {} as unknown as PrismaService,
      {} as unknown as ProductsService,
    );
  });

  it('claims the order with a PENDING predicate and returns "paid"', async () => {
    const outcome = await service.markPaid(
      tx as unknown as Prisma.TransactionClient,
      'order-1',
    );

    expect(outcome).toBe('paid');
    expect(tx.order.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'order-1', status: OrderStatus.PENDING },
      data: { status: OrderStatus.PAID },
    });
  });

  // The CAS miss is classified by a follow-up read, exactly as cancel() does.
  it('returns "already-paid" when the CAS misses and the order is PAID', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    tx.order.findUnique.mockResolvedValue({ status: OrderStatus.PAID });

    expect(
      await service.markPaid(tx as unknown as Prisma.TransactionClient, 'o'),
    ).toBe('already-paid');
  });

  it('returns "cancelled" when the CAS misses and the order is CANCELLED', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    tx.order.findUnique.mockResolvedValue({ status: OrderStatus.CANCELLED });

    expect(
      await service.markPaid(tx as unknown as Prisma.TransactionClient, 'o'),
    ).toBe('cancelled');
  });

  it('returns "not-found" for an unknown order', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    tx.order.findUnique.mockResolvedValue(null);

    expect(
      await service.markPaid(tx as unknown as Prisma.TransactionClient, 'o'),
    ).toBe('not-found');
  });

  // It is called from a webhook. Throwing would surface as a 404 to the
  // provider, which reads that as "never retry".
  it('never throws on any of the four paths', async () => {
    for (const row of [
      { status: OrderStatus.PAID },
      { status: OrderStatus.CANCELLED },
      null,
    ]) {
      tx.order.updateMany.mockResolvedValue({ count: 0 });
      tx.order.findUnique.mockResolvedValue(row);

      await expect(
        service.markPaid(tx as unknown as Prisma.TransactionClient, 'o'),
      ).resolves.toEqual(expect.any(String));
    }
  });

  // It writes through the CALLER's transaction, never this.prisma — the same
  // rule decrementStock(tx, …) follows.
  it('uses only the transaction client it was given', async () => {
    await service.markPaid(tx as unknown as Prisma.TransactionClient, 'order-1');

    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
  });
});
```

Add to the existing `OrdersService.cancel` describe:

```ts
  it('returns 409 when the order is already PAID, and restores no stock', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.PAID,
      items: [],
    });

    await expect(service.cancel('user-1', 'order-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(products.incrementStock).not.toHaveBeenCalled();
  });

  it('still returns the order idempotently when it is already CANCELLED', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.CANCELLED,
      items: [],
    });

    await expect(service.cancel('user-1', 'order-1')).resolves.toEqual(
      expect.objectContaining({ id: 'order-1' }),
    );
    expect(products.incrementStock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/modules/orders/orders.service.spec.ts --silent`
Expected: FAIL — `service.markPaid is not a function`, and the PAID-cancel test resolves instead of rejecting.

- [ ] **Step 3: Implement `markPaid`**

In `src/modules/orders/orders.service.ts`, add the type export above the class:

```ts
export type MarkPaidOutcome =
  | 'paid'
  | 'already-paid'
  | 'cancelled'
  | 'not-found';
```

and the method inside the class, after `cancel`:

```ts
  /**
   * The ONLY writer of OrderStatus.PAID anywhere in src/ (D9, C6).
   *
   * `tx` is REQUIRED, with no default, exactly as ProductsService
   * .decrementStock(tx, …) is: the write must run inside the caller's
   * transaction — the webhook's — so the event insert, the payment promotion
   * and this transition commit or roll back together.
   *
   * The updateMany is a compare-and-swap: only the caller whose write matched
   * a PENDING row transitions the order, so duplicate or concurrent webhook
   * deliveries transition it EXACTLY ONCE. Do not replace it with a read, a
   * status check and an update.
   *
   * It NEVER throws. Its caller is a webhook handler, and a thrown
   * NotFoundException would reach the payment provider as a 404 — which most
   * providers read as "this event is permanently rejected, stop retrying".
   * The outcome is returned instead and the caller chooses the response,
   * which for the webhook is always 200.
   */
  async markPaid(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<MarkPaidOutcome> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING },
      data: { status: OrderStatus.PAID },
    });

    if (count === 1) {
      return 'paid';
    }

    // Same shape as cancel()'s CAS-miss branch: classify by reading the row.
    const existing = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });

    if (existing === null) {
      return 'not-found';
    }

    return existing.status === OrderStatus.PAID ? 'already-paid' : 'cancelled';
  }
```

Add `Prisma` to the `@prisma/client` import.

- [ ] **Step 4: Split `cancel()`'s CAS-miss branch**

In `cancel()`, replace the single `return existing;` branch. **Do not touch the `updateMany` predicate.**

```ts
      if (count === 0) {
        const existing = await tx.order.findFirst({
          where: { id: orderId, userId },
          include: { items: true },
        });

        // Unknown, or another user's: both are 404, so existence never leaks.
        if (!existing) {
          throw new NotFoundException('Order not found');
        }

        // Phase 4: a paid order cannot be cancelled. Cancelling would restore
        // stock for goods that were paid for and would owe a refund, which is
        // out of scope. This is a different answer from the already-cancelled
        // case below, so the two are split rather than sharing one return.
        if (existing.status === OrderStatus.PAID) {
          throw new ConflictException('Order is already paid');
        }

        // Already cancelled: idempotent, and stock is NOT restored again.
        return existing;
      }
```

Add `ConflictException` to the `@nestjs/common` import.

- [ ] **Step 5: Export `OrdersService`**

In `src/modules/orders/orders.module.ts`, add `exports: [OrdersService],`.

**Do not export `CheckoutService`** — nothing outside the module calls it, and exporting it would widen the module's surface for no consumer.

- [ ] **Step 6: Document the new status on the cancel route**

In `src/modules/orders/orders.controller.ts`, on the `cancel` handler, add:

```ts
  @ApiResponse({
    status: 409,
    description: 'The order is already paid and cannot be cancelled',
  })
```

and extend the `@ApiOperation` description: `'… Cancelling a paid order returns 409 and restores no stock.'`

- [ ] **Step 7: Run the unit tests and watch them pass**

Run: `npx jest src/modules/orders --silent`
Expected: PASS, including every pre-existing `cancel` test.

- [ ] **Step 8: Write the e2e coverage**

Append to `test/orders.e2e-spec.ts`. Setting the order to `PAID` directly with `prisma.order.update` is correct **here** — this is a cancellation test, not a webhook test. (The webhook suite must reach `PAID` through a signed event; see Task 7.)

```ts
  describe('cancelling a paid order', () => {
    it('returns 409 and does not restore stock', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 10,
      });
      const order = await createOrder(prisma, user.id, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 2,
        },
      ]);

      // The factory does not decrement stock, so mirror checkout by hand:
      // conservation is asserted against 8 held-by-order units below.
      await prisma.product.update({
        where: { id: product.id },
        data: { stockQuantity: 8 },
      });
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.PAID },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });

      expect(after.stockQuantity).toBe(8);

      // A PAID order still holds its stock: 8 remaining + 2 held = 10.
      await assertStockConserved(prisma, product.id, 10);

      const reread = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });

      expect(reread.status).toBe(OrderStatus.PAID);
      expect(reread.cancelledAt).toBeNull();
    });
  });
```

- [ ] **Step 9: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS. A failure inside `assertStockConserved` means Task 1 Step 7 was skipped.

- [ ] **Step 10: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 11: Commit**

```bash
git add src/modules/orders test/orders.e2e-spec.ts
git commit -m "feat(orders): add markPaid CAS and refuse cancellation of a paid order

OrdersService.markPaid(tx, orderId) is the only writer of OrderStatus.PAID
anywhere in src/, keeping the orders table under one owning module. tx is a
required parameter, as decrementStock(tx, ...) is, so the transition commits
with the webhook's event insert and payment promotion or not at all.

The updateMany is a compare-and-swap on status: PENDING, so duplicate or
concurrent deliveries transition an order exactly once. It never throws: a
NotFoundException would reach the payment provider as a 404, which providers
read as a permanent rejection. It returns a discriminated outcome instead.

cancel()'s CAS-miss branch now splits PAID (409, no stock restored) from
CANCELLED (200, idempotent). The CAS predicate itself is unchanged, so
exactly-once cancellation is preserved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Payment initiation

**Objective:** Ship `POST /api/v1/orders/:id/payments` implementing spec §7.3 exactly — owner-scoped, empty body, amount from the persisted order, limits checked before any provider call, and the **local `Payment` row** (not the provider key) as the durable idempotency guarantee (C3).

**Files:**
- Create: `src/modules/payments/payments.service.ts`
- Create: `src/modules/payments/payments.service.spec.ts`
- Create: `src/modules/payments/payments.controller.ts`
- Create: `src/modules/payments/dto/payment-response.dto.ts`
- Modify: `src/modules/payments/payments.module.ts`
- Create: `test/payments.e2e-spec.ts`

**Interfaces:**
- Consumes: `PAYMENT_PROVIDER` (Task 3), `PrismaService`.
- Produces: `PaymentsService.initiate(userId, orderId): Promise<InitiateResult>` where `InitiateResult = { payment: Payment; clientSecret: string; created: boolean }`; `PaymentResponseDto.from(payment, clientSecret)`.

**What must NOT be changed in this task:** `src/modules/orders/**`, the port's shape, `HttpExceptionFilter`, `prisma/`.

**Database implications:** none beyond Task 1's tables. **No transaction is opened by this task** (spec §10.2).

- [ ] **Step 1: Write the failing service unit tests**

Create `src/modules/payments/payments.service.spec.ts`:

```ts
import {
  BadGatewayException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentsService } from './payments.service';
import {
  CreatePaymentInput,
  PaymentProvider,
  ProviderPayment,
} from './provider/payment-provider';

const ORDER = {
  id: 'order-1',
  userId: 'user-1',
  status: OrderStatus.PENDING,
  totalCents: 1000,
  currency: 'USD',
};

const CREATED: ProviderPayment = {
  providerPaymentId: 'pi_1',
  clientSecret: 'pi_1_secret',
  amountMinorUnits: 1000,
  currency: 'USD',
};

describe('PaymentsService.initiate', () => {
  let service: PaymentsService;
  let prisma: {
    order: { findFirst: jest.Mock<Promise<unknown>, [unknown]> };
    payment: {
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
      findUniqueOrThrow: jest.Mock<Promise<unknown>, [unknown]>;
      createMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
    $transaction: jest.Mock<Promise<unknown>, [unknown]>;
  };
  let provider: {
    createPayment: jest.Mock<Promise<ProviderPayment>, [CreatePaymentInput]>;
    retrievePayment: jest.Mock<Promise<ProviderPayment>, [string]>;
    verifyWebhook: jest.Mock;
    amountLimits: jest.Mock<
      { minMinorUnits: number; maxMinorUnits: number } | null,
      [string]
    >;
  };

  beforeEach(() => {
    prisma = {
      order: {
        findFirst: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(ORDER),
      },
      payment: {
        findUnique: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue(null),
        findUniqueOrThrow: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({
            id: 'pay-1',
            orderId: 'order-1',
            providerPaymentId: 'pi_1',
            status: PaymentStatus.PENDING,
          }),
        createMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn<Promise<unknown>, [unknown]>(),
    };
    provider = {
      createPayment: jest
        .fn<Promise<ProviderPayment>, [CreatePaymentInput]>()
        .mockResolvedValue(CREATED),
      retrievePayment: jest
        .fn<Promise<ProviderPayment>, [string]>()
        .mockResolvedValue(CREATED),
      verifyWebhook: jest.fn(),
      amountLimits: jest
        .fn<{ minMinorUnits: number; maxMinorUnits: number } | null, [string]>()
        .mockReturnValue({ minMinorUnits: 50, maxMinorUnits: 99_999_999 }),
    };

    service = new PaymentsService(
      prisma as unknown as PrismaService,
      provider as unknown as PaymentProvider,
    );
  });

  describe('ownership and status', () => {
    it('scopes the lookup to the caller', async () => {
      await service.initiate('user-1', 'order-1');

      expect(prisma.order.findFirst.mock.calls[0][0]).toEqual({
        where: { id: 'order-1', userId: 'user-1' },
      });
    });

    it('404s for an unknown or another user’s order, calling no provider', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(service.initiate('user-2', 'order-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('409s for a cancelled order', async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...ORDER,
        status: OrderStatus.CANCELLED,
      });

      await expect(service.initiate('user-1', 'order-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('409s for an already paid order', async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...ORDER,
        status: OrderStatus.PAID,
      });

      await expect(service.initiate('user-1', 'order-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(provider.createPayment).not.toHaveBeenCalled();
    });
  });

  describe('amount integrity', () => {
    it('sends the persisted amount and currency, and the order id as the key', async () => {
      await service.initiate('user-1', 'order-1');

      expect(provider.createPayment.mock.calls[0][0]).toEqual({
        orderId: 'order-1',
        amountMinorUnits: 1000,
        currency: 'USD',
        idempotencyKey: 'order-1',
      });
    });

    // A1: the limit check runs BEFORE the provider call, so an unpayable
    // order never creates an intent.
    it('422s above the maximum without calling the provider', async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...ORDER,
        totalCents: 100_000_000,
      });

      await expect(service.initiate('user-1', 'order-1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('422s below the minimum without calling the provider', async () => {
      prisma.order.findFirst.mockResolvedValue({ ...ORDER, totalCents: 49 });

      await expect(service.initiate('user-1', 'order-1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('422s for an unsupported currency without calling the provider', async () => {
      provider.amountLimits.mockReturnValue(null);

      await expect(service.initiate('user-1', 'order-1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(provider.createPayment).not.toHaveBeenCalled();
    });
  });

  describe('idempotency (C3)', () => {
    it('creates on the first attempt and reports created=true', async () => {
      const result = await service.initiate('user-1', 'order-1');

      expect(result.created).toBe(true);
      expect(result.clientSecret).toBe('pi_1_secret');
      expect(provider.retrievePayment).not.toHaveBeenCalled();
    });

    // The concurrent loser: createMany matched nothing, but the row that won
    // holds the same intent, so no extra network call is needed.
    it('reports created=false when the insert was skipped but the intent matches', async () => {
      prisma.payment.createMany.mockResolvedValue({ count: 0 });

      const result = await service.initiate('user-1', 'order-1');

      expect(result.created).toBe(false);
      expect(result.clientSecret).toBe('pi_1_secret');
      expect(provider.retrievePayment).not.toHaveBeenCalled();
    });

    // THE C3 RESOLUTION: once a row exists, createPayment is never called
    // again — retrieval by id has no retention window.
    it('retrieves instead of creating when a Payment row already exists', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        orderId: 'order-1',
        providerPaymentId: 'pi_existing',
        status: PaymentStatus.PENDING,
      });

      const result = await service.initiate('user-1', 'order-1');

      expect(provider.createPayment).not.toHaveBeenCalled();
      expect(provider.retrievePayment).toHaveBeenCalledWith('pi_existing');
      expect(result.created).toBe(false);
    });

    // skipDuplicates skips on ANY unique conflict, and `payments` has two.
    // `count` alone is therefore not trustworthy: the row must be read back
    // and its providerPaymentId compared (spec §11.5).
    it('falls back to retrieve when the persisted intent differs from the created one', async () => {
      prisma.payment.createMany.mockResolvedValue({ count: 0 });
      prisma.payment.findUniqueOrThrow.mockResolvedValue({
        id: 'pay-1',
        orderId: 'order-1',
        providerPaymentId: 'pi_other',
        status: PaymentStatus.PENDING,
      });
      provider.retrievePayment.mockResolvedValue({
        ...CREATED,
        providerPaymentId: 'pi_other',
        clientSecret: 'pi_other_secret',
      });

      const result = await service.initiate('user-1', 'order-1');

      expect(provider.retrievePayment).toHaveBeenCalledWith('pi_other');
      expect(result.clientSecret).toBe('pi_other_secret');
      expect(result.created).toBe(false);
    });
  });

  describe('provider failure', () => {
    it('maps a create failure to 502 without leaking the provider message', async () => {
      provider.createPayment.mockRejectedValue(
        new Error('stripe: card_declined at api.stripe.com'),
      );

      const error = await service
        .initiate('user-1', 'order-1')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadGatewayException);
      expect(JSON.stringify(error)).not.toContain('stripe');
      expect(prisma.payment.createMany).not.toHaveBeenCalled();
    });

    it('maps a retrieve failure to 502 as well', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        orderId: 'order-1',
        providerPaymentId: 'pi_existing',
        status: PaymentStatus.PENDING,
      });
      provider.retrievePayment.mockRejectedValue(new Error('network timeout'));

      await expect(service.initiate('user-1', 'order-1')).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });
  });

  // The structural guarantee, made runnable. $transaction is never used by
  // this service; if a future change wraps the provider call in one, this
  // fails.
  describe('no provider I/O inside a transaction', () => {
    it('never opens a Prisma transaction', async () => {
      await service.initiate('user-1', 'order-1');

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('calls no provider method while a transaction is open', async () => {
      let insideTransaction = false;

      prisma.$transaction.mockImplementation(async (callback: unknown) => {
        insideTransaction = true;
        try {
          return await (callback as (tx: unknown) => Promise<unknown>)(prisma);
        } finally {
          insideTransaction = false;
        }
      });

      const assertOutside = (): void => {
        if (insideTransaction) {
          throw new Error('provider called inside a transaction');
        }
      };

      provider.createPayment.mockImplementation(async () => {
        assertOutside();

        return CREATED;
      });
      provider.retrievePayment.mockImplementation(async () => {
        assertOutside();

        return CREATED;
      });

      await expect(service.initiate('user-1', 'order-1')).resolves.toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/modules/payments/payments.service --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `PaymentsService`**

Create `src/modules/payments/payments.service.ts`:

```ts
import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, Payment, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderPayment,
} from './provider/payment-provider';

export interface InitiateResult {
  payment: Payment;
  clientSecret: string;
  /** True only for the request whose insert actually created the row. */
  created: boolean;
}

const UNSUPPORTED_CURRENCY = 'Currency is not supported for payment';
const OUT_OF_RANGE = 'Order total is outside the payable range';
const PROVIDER_UNAVAILABLE = 'Payment provider unavailable';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * Spec §7.3. NO TRANSACTION IS OPENED ANYWHERE IN THIS METHOD.
   *
   * Every database statement is a single autocommit operation, and the
   * one invariant — one payment per order — is enforced by the
   * @@unique([orderId]) index rather than by a transaction. Wrapping the
   * reads and the insert would buy nothing; wrapping the provider call too
   * would put network I/O inside a transaction, which is forbidden.
   *
   * The DURABLE idempotency guarantee is the local Payment row, NOT the
   * provider's idempotency key. Key retention is bounded (C3): once it
   * lapses, the same key yields a NEW intent. Retrieval by id has no such
   * window, so a row that exists is always resolved with retrievePayment.
   */
  async initiate(userId: string, orderId: string): Promise<InitiateResult> {
    // 1. Ownership is structural: another user's order and a non-existent one
    //    are both 404, so existence never leaks.
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.status === OrderStatus.CANCELLED) {
      throw new ConflictException('Order is cancelled');
    }

    if (order.status === OrderStatus.PAID) {
      throw new ConflictException('Order is already paid');
    }

    // 2. Pure, no I/O, and BEFORE any provider call: an unpayable order must
    //    never create an intent (C4, A1). 422 not 409 — the request is
    //    coherent and the order is fine; it is the amount that cannot be
    //    processed.
    const limits = this.provider.amountLimits(order.currency);

    if (limits === null) {
      throw new UnprocessableEntityException(UNSUPPORTED_CURRENCY);
    }

    if (
      order.totalCents < limits.minMinorUnits ||
      order.totalCents > limits.maxMinorUnits
    ) {
      throw new UnprocessableEntityException(OUT_OF_RANGE);
    }

    // 3. The replay key.
    let payment = await this.prisma.payment.findUnique({ where: { orderId } });

    if (payment === null) {
      // 4. Outside any transaction. Amount and currency come from the
      //    persisted order; the client supplies neither.
      const created = await this.callProvider(() =>
        this.provider.createPayment({
          orderId: order.id,
          amountMinorUnits: order.totalCents,
          currency: order.currency,
          idempotencyKey: order.id,
        }),
      );

      const { count } = await this.prisma.payment.createMany({
        data: {
          orderId: order.id,
          providerPaymentId: created.providerPaymentId,
          status: PaymentStatus.PENDING,
        },
        skipDuplicates: true,
      });

      // skipDuplicates skips on ANY unique conflict and this table has two
      // (orderId, providerPaymentId), so `count` does not identify which one
      // fired. The row is read back and compared rather than trusted.
      payment = await this.prisma.payment.findUniqueOrThrow({
        where: { orderId },
      });

      if (payment.providerPaymentId === created.providerPaymentId) {
        // count === 1 means this request's insert won: 201. count === 0 means
        // a concurrent request persisted the SAME intent first: 200, and no
        // extra network call, because `created` already holds its secret.
        return { payment, clientSecret: created.clientSecret, created: count === 1 };
      }

      // A concurrent request persisted a DIFFERENT intent. The database is
      // authoritative; fall through and retrieve the one that is recorded.
      this.logger.warn(
        `Order ${order.id} already had payment intent ${payment.providerPaymentId}; discarding ${created.providerPaymentId}`,
      );
    }

    // 5. Replay, still outside any transaction. Retrieval by id is what makes
    //    the guarantee outlive the provider's key retention window.
    const retrieved = await this.callProvider(() =>
      this.provider.retrievePayment(payment.providerPaymentId),
    );

    return { payment, clientSecret: retrieved.clientSecret, created: false };
  }

  /**
   * The provider's own error text never reaches the client: it can carry
   * account ids, request ids and decline reasons. It is logged server-side
   * and replaced with one fixed message.
   */
  private async callProvider(
    call: () => Promise<ProviderPayment>,
  ): Promise<ProviderPayment> {
    try {
      return await call();
    } catch (error: unknown) {
      this.logger.error(
        `Payment provider call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );

      throw new BadGatewayException(PROVIDER_UNAVAILABLE);
    }
  }
}
```

**Note on the one `try/catch`:** it wraps a **provider** call, never a Prisma call. The project's "Prisma errors are never caught" rule is untouched — no Prisma error passes through it.

- [ ] **Step 4: Write the response DTO**

Create `src/modules/payments/dto/payment-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Payment, PaymentStatus } from '@prisma/client';

export class PaymentResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000001' })
  orderId!: string;

  @ApiProperty({ enum: PaymentStatus, example: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @ApiProperty({
    example: 'pi_3Ab_secret_9Cd',
    description:
      'Hand this to the payment provider’s client tooling to complete the ' +
      'payment. This API never completes it: the signed webhook is the only ' +
      'thing that marks the order paid.',
  })
  clientSecret!: string;

  @ApiProperty()
  createdAt!: Date;

  /**
   * providerPaymentId is deliberately NOT exposed — nothing consumes it.
   * That is YAGNI, not secrecy: the client secret embeds the intent id, so
   * omitting the field is not a security measure and must not be described
   * as one.
   */
  static from(payment: Payment, clientSecret: string): PaymentResponseDto {
    const dto = new PaymentResponseDto();

    dto.id = payment.id;
    dto.orderId = payment.orderId;
    dto.status = payment.status;
    dto.clientSecret = clientSecret;
    dto.createdAt = payment.createdAt;

    return dto;
  }
}
```

- [ ] **Step 5: Write the controller**

Create `src/modules/payments/payments.controller.ts`. It mounts under the `orders` prefix; Nest allows two controllers to share a prefix when the sub-paths differ.

```ts
import {
  Controller,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { PaymentResponseDto } from './dto/payment-response.dto';

/**
 * One trust posture per controller class (C7). Every route here is
 * bearer-authenticated and owner-scoped; the webhook lives in its own
 * @Public() controller so the two decorators are never adjacent.
 */
@ApiTags('payments')
@ApiBearerAuth()
@Controller('orders')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post(':id/payments')
  @ApiOperation({
    summary: 'Start paying for one of the caller’s orders',
    description:
      'Creates a payment intent for the order, or returns the existing one. ' +
      'The request body is empty by design: the amount and currency come ' +
      'from the persisted order and are never taken from the client. ' +
      'Repeating the request never creates a second intent. ' +
      'This endpoint does NOT complete the payment — completion happens ' +
      'out-of-band with the provider’s tooling, and only the signed ' +
      'webhook marks the order paid.',
  })
  @ApiResponse({ status: 201, description: 'Payment intent created' })
  @ApiResponse({ status: 200, description: 'Existing payment intent returned' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 404,
    description: 'No such order, or it belongs to another user',
  })
  @ApiResponse({
    status: 409,
    description: 'The order is cancelled, or already paid',
  })
  @ApiResponse({
    status: 422,
    description:
      'The order total is outside the payable range, or its currency is ' +
      'not supported for payment',
  })
  @ApiResponse({ status: 502, description: 'Payment provider unavailable' })
  async initiate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentResponseDto> {
    const result = await this.paymentsService.initiate(request.user!.sub, id);

    // The status varies, so it is set here rather than with @HttpCode —
    // the same pattern OrdersController.checkout uses. The service never
    // touches the response object.
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);

    return PaymentResponseDto.from(result.payment, result.clientSecret);
  }
}
```

- [ ] **Step 6: Register the controller and service**

In `src/modules/payments/payments.module.ts`, add `imports: [PrismaModule]` (if `PrismaModule` is not global), `controllers: [PaymentsController]`, and `PaymentsService` to `providers`. Keep the `PAYMENT_PROVIDER` factory and `exports` exactly as Task 3 left them.

- [ ] **Step 7: Run the unit tests and watch them pass**

Run: `npx jest src/modules/payments --silent`
Expected: PASS.

- [ ] **Step 8: Write the deterministic e2e suite**

Create `test/payments.e2e-spec.ts`. It boots the real app (fake provider by configuration) and reaches the `FakePaymentProvider` instance through the DI token so it can assert create counts and simulate retention expiry.

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/provider/payment-provider';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { createOrder } from './factories/order.factory';

/** response.body is `any`; cast once, as every other e2e suite does. */
interface PaymentBody {
  id: string;
  orderId: string;
  status: string;
  clientSecret: string;
  createdAt: string;
}

const paymentBody = (response: { body: unknown }): PaymentBody =>
  response.body as PaymentBody;

describe('Payment initiation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // The provider's state is in memory: truncateAll does not touch it.
    provider.reset();
  });

  async function payableOrder(totalCents = 1000) {
    const user = await createUser(prisma);
    const token = await tokens.signAccessToken(user);
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      priceCents: totalCents,
      stockQuantity: 10,
    });
    const order = await createOrder(prisma, user.id, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: totalCents,
        quantity: 1,
      },
    ]);

    return { user, token, product, order };
  }

  const initiate = (orderId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${token}`);

  describe('happy path', () => {
    it('creates an intent with 201 and returns a client secret', async () => {
      const { order, token } = await payableOrder();

      const response = await initiate(order.id, token).expect(201);

      expect(paymentBody(response).orderId).toBe(order.id);
      expect(paymentBody(response).status).toBe('PENDING');
      expect(typeof paymentBody(response).clientSecret).toBe('string');
      expect(paymentBody(response).clientSecret.length).toBeGreaterThan(0);
      expect(provider.createCountFor(order.id)).toBe(1);
    });

    it('never exposes providerPaymentId in the response', async () => {
      const { order, token } = await payableOrder();
      const response = await initiate(order.id, token).expect(201);

      expect(paymentBody(response)).not.toHaveProperty('providerPaymentId');
    });

    it('leaves the order PENDING — initiation never pays anything (D11)', async () => {
      const { order, token } = await payableOrder();

      await initiate(order.id, token).expect(201);

      const reread = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });

      expect(reread.status).toBe('PENDING');
    });
  });

  describe('replay', () => {
    it('returns 200 with the same payment on a second call', async () => {
      const { order, token } = await payableOrder();

      const first = await initiate(order.id, token).expect(201);
      const second = await initiate(order.id, token).expect(200);

      expect(paymentBody(second).id).toBe(paymentBody(first).id);
      expect(paymentBody(second).clientSecret).toBe(
        paymentBody(first).clientSecret,
      );
      expect(provider.createCountFor(order.id)).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
    });

    // I1, deterministic half: the local row outlives the provider's key
    // retention window. Task 8 pairs this with its negative control.
    it('still returns the persisted intent after key retention expires', async () => {
      const { order, token } = await payableOrder();

      const first = await initiate(order.id, token).expect(201);

      provider.expireIdempotencyKeys();

      const second = await initiate(order.id, token).expect(200);

      expect(paymentBody(second).clientSecret).toBe(
        paymentBody(first).clientSecret,
      );
      expect(provider.createCountFor(order.id)).toBe(1);

      const stored = await prisma.payment.findUniqueOrThrow({
        where: { orderId: order.id },
      });

      expect(paymentBody(second).clientSecret).toContain(stored.providerPaymentId);
    });
  });

  describe('ownership', () => {
    it('404s on another user’s order — not 403, and not 200', async () => {
      const { order } = await payableOrder();
      const intruder = await createUser(prisma);
      const intruderToken = await tokens.signAccessToken(intruder);

      await initiate(order.id, intruderToken).expect(404);

      expect(await prisma.payment.count()).toBe(0);
      expect(provider.createCountFor(order.id)).toBe(0);
    });

    it('404s on an unknown order', async () => {
      const { token } = await payableOrder();

      await initiate('0195f0a0-0000-7000-8000-0000000000ff', token).expect(404);
    });

    it('401s without a token', async () => {
      const { order } = await payableOrder();

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.id}/payments`)
        .expect(401);
    });

    it('400s on a malformed order id', async () => {
      const { token } = await payableOrder();

      await initiate('not-a-uuid', token).expect(400);
    });
  });

  describe('order status', () => {
    it('409s for a cancelled order', async () => {
      const { order, token } = await payableOrder();

      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      await initiate(order.id, token).expect(409);
      expect(provider.createCountFor(order.id)).toBe(0);
    });

    it('409s for an order that is already paid', async () => {
      const { order, token } = await payableOrder();

      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'PAID' },
      });

      await initiate(order.id, token).expect(409);
      expect(provider.createCountFor(order.id)).toBe(0);
    });
  });

  // A1, deterministic half.
  describe('payable range', () => {
    it('422s above the maximum, creating no intent', async () => {
      const { order, token } = await payableOrder(100_000_000);

      await initiate(order.id, token).expect(422);
      expect(provider.createCountFor(order.id)).toBe(0);
      expect(await prisma.payment.count()).toBe(0);
    });

    it('422s below the minimum, creating no intent', async () => {
      const { order, token } = await payableOrder(49);

      await initiate(order.id, token).expect(422);
      expect(provider.createCountFor(order.id)).toBe(0);
    });

    it('422s for an unsupported currency', async () => {
      const { order, token } = await payableOrder();

      await prisma.order.update({
        where: { id: order.id },
        data: { currency: 'EUR' },
      });

      await initiate(order.id, token).expect(422);
      expect(provider.createCountFor(order.id)).toBe(0);
    });

    it('accepts an order exactly at each boundary', async () => {
      const low = await payableOrder(50);

      await initiate(low.order.id, low.token).expect(201);

      const high = await payableOrder(99_999_999);

      await initiate(high.order.id, high.token).expect(201);
    });
  });

  describe('provider failure', () => {
    it('502s and persists nothing when the provider rejects', async () => {
      const { order, token } = await payableOrder();

      provider.failNextCreate('simulated outage');

      const response = await initiate(order.id, token).expect(502);

      expect(JSON.stringify(response.body)).not.toContain('simulated outage'); // JSON.stringify accepts unknown safely
      expect(await prisma.payment.count()).toBe(0);
    });

    it('recovers on the next attempt', async () => {
      const { order, token } = await payableOrder();

      provider.failNextCreate('simulated outage');
      await initiate(order.id, token).expect(502);

      await initiate(order.id, token).expect(201);
    });
  });

  describe('stock', () => {
    it('never changes stock', async () => {
      const { order, token, product } = await payableOrder();
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });

      await initiate(order.id, token).expect(201);

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });

      expect(after.stockQuantity).toBe(before.stockQuantity);
    });
  });
});
```

- [ ] **Step 9: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 10: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 11: Commit**

```bash
git add src/modules/payments test/payments.e2e-spec.ts
git commit -m "feat(payments): add owner-scoped payment initiation

POST /api/v1/orders/:id/payments. The request body is empty: amount and
currency come from the persisted order and are never taken from the client.
Ownership is a where: { id, userId } lookup, so another user's order is 404,
never 403.

The durable idempotency guarantee is the local Payment row, not the provider
key. Provider key retention is bounded, so once a row exists the service
calls retrievePayment - a lookup by id, with no retention window - instead of
creating a second intent. Because skipDuplicates skips on any unique conflict
and payments has two, the inserted row is read back and its providerPaymentId
compared rather than inferring the outcome from count alone.

The payable range is checked before any provider call, so an unpayable order
never creates an intent (422, not 409). Provider errors become a fixed 502
with the provider's own message logged, never returned.

No Prisma transaction is opened anywhere in this path; two unit tests enforce
that structurally.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The webhook endpoint — raw body, signature, classification

**Objective:** Ship `POST /api/v1/payments/webhook` as a verified, public, throttled endpoint that classifies events and returns the right status for every non-state case. **No database writes in this task** — state application is Task 7, so the trust boundary is proven before any business logic depends on it.

**Files:**
- Create: `src/modules/payments/payments-webhook.controller.ts`
- Create: `src/modules/payments/payments-webhook.controller.spec.ts`
- Modify: `src/modules/payments/payments.module.ts`
- Create: `test/payments-webhook.e2e-spec.ts`

**Interfaces:**
- Consumes: `PAYMENT_PROVIDER` (Task 3), `NEST_APP_OPTIONS` (Task 1), `SUPPORTED_EVENT_TYPE`.
- Produces: `PaymentsWebhookController.handle(request, signature)` returning `{ received: true }`. Task 7 replaces its "unsupported/ignored" body with a call into `PaymentWebhookService`.

**What must NOT be changed in this task:** `src/modules/orders/**`, `PaymentsService`, `HttpExceptionFilter`, `src/app.module.ts`, `src/bootstrap.ts`.

**Database implications:** none in this task.

**Why this is split from Task 7:** the webhook has exactly one authentication mechanism — the signature over the raw bytes. If that boundary is wrong, every state test in Task 7 would be testing a pipeline that a forged request can also reach. Proving it alone, first, makes the failure impossible to mistake for a business-logic bug.

- [ ] **Step 1: Write the failing controller unit tests**

Create `src/modules/payments/payments-webhook.controller.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsWebhookController } from './payments-webhook.controller';
import {
  PaymentProvider,
  ProviderEvent,
  SUPPORTED_EVENT_TYPE,
} from './provider/payment-provider';

const EVENT: ProviderEvent = {
  providerEventId: 'evt_1',
  type: SUPPORTED_EVENT_TYPE,
  providerPaymentId: 'pi_1',
  orderId: 'order-1',
  amountMinorUnits: 1000,
  currency: 'USD',
};

function requestWith(rawBody: Buffer | undefined): RawBodyRequest<Request> {
  return { rawBody } as unknown as RawBodyRequest<Request>;
}

describe('PaymentsWebhookController', () => {
  let controller: PaymentsWebhookController;
  let provider: {
    verifyWebhook: jest.Mock<ProviderEvent, [Buffer, string]>;
  };

  beforeEach(() => {
    provider = {
      verifyWebhook: jest
        .fn<ProviderEvent, [Buffer, string]>()
        .mockReturnValue(EVENT),
    };

    controller = new PaymentsWebhookController(
      provider as unknown as PaymentProvider,
    );
  });

  it('verifies against the RAW bytes, not the parsed body', () => {
    const raw = Buffer.from('{"a":1}');

    controller.handle(requestWith(raw), 'sig');

    expect(provider.verifyWebhook).toHaveBeenCalledWith(raw, 'sig');
  });

  it('returns { received: true } for a supported event', () => {
    expect(controller.handle(requestWith(Buffer.from('{}')), 'sig')).toEqual({
      received: true,
    });
  });

  it('acknowledges an unsupported event type without erroring', () => {
    provider.verifyWebhook.mockReturnValue({
      ...EVENT,
      type: 'payment_intent.payment_failed',
    });

    expect(controller.handle(requestWith(Buffer.from('{}')), 'sig')).toEqual({
      received: true,
    });
  });

  it('400s when the signature header is missing', () => {
    expect(() =>
      controller.handle(requestWith(Buffer.from('{}')), undefined),
    ).toThrow(BadRequestException);
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
  });

  it('400s when verification throws', () => {
    provider.verifyWebhook.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });

    expect(() =>
      controller.handle(requestWith(Buffer.from('{}')), 'bad'),
    ).toThrow(BadRequestException);
  });

  it('never leaks the provider’s verification message', () => {
    provider.verifyWebhook.mockImplementation(() => {
      throw new Error('timestamp outside the tolerance zone');
    });

    const error = (() => {
      try {
        controller.handle(requestWith(Buffer.from('{}')), 'bad');
      } catch (caught: unknown) {
        return caught;
      }

      return null;
    })();

    expect(JSON.stringify(error)).not.toContain('tolerance');
  });

  // A misconfiguration that silently disabled signature checking on a money
  // endpoint is the worst outcome available in this phase, so it must be
  // LOUD: a 500, never a fallback to an empty buffer.
  it('throws a non-4xx error when rawBody is missing entirely', () => {
    expect(() => controller.handle(requestWith(undefined), 'sig')).toThrow(
      /raw body/i,
    );

    const error = (() => {
      try {
        controller.handle(requestWith(undefined), 'sig');
      } catch (caught: unknown) {
        return caught;
      }

      return null;
    })();

    expect(error).not.toBeInstanceOf(BadRequestException);
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/modules/payments/payments-webhook --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the controller**

Create `src/modules/payments/payments-webhook.controller.ts`:

```ts
import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderEvent,
  SUPPORTED_EVENT_TYPE,
} from './provider/payment-provider';

export interface WebhookAck {
  received: true;
}

/**
 * The webhook lives in its OWN controller, separate from PaymentsController,
 * for the same reason admin-products.controller.ts is split from
 * products.controller.ts: ONE TRUST POSTURE PER CLASS (C7). Everything here is
 * @Public(); everything there is bearer-authenticated. Mixing them would put
 * @Public() one careless copy-paste away from a money endpoint that must
 * never be public.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * @Public() is MANDATORY: the provider sends no bearer token, JwtAuthGuard
   * is global and fails closed, and without this every delivery is 401 and no
   * order ever becomes paid. Authentication here IS the signature.
   *
   * The raised throttle (D8, C5) rather than @SkipThrottle(): every delivery
   * arrives from one provider's small IP set, so the global 100/min per
   * handler per IP would throttle legitimate bursts — but skipping entirely
   * would leave an unauthenticated endpoint doing HMAC and database work with
   * no protection at all. The key MUST be `default`: that is the name
   * ThrottlerModule.forRoot assigns when none is given, and any other key is
   * ignored SILENTLY.
   *
   * This endpoint does not close the open trusted-proxy limitation in
   * docs/deferred-limitations.md; it sits inside its blast radius.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Payment provider webhook',
    description:
      'Signature-verified. This is the ONLY path that marks an order paid. ' +
      'Returns 200 for every authentic delivery it understands, including ' +
      'ones it deliberately does not act on, so the provider stops retrying; ' +
      'only an invalid signature or an unusable payload is 4xx.',
  })
  @ApiResponse({ status: 200, description: 'Delivery acknowledged' })
  @ApiResponse({
    status: 400,
    description: 'Invalid signature, or an unusable payload',
  })
  handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): WebhookAck {
    const event = this.verify(request, signature);

    // D4: exactly one event type changes authoritative state. Everything else
    // is acknowledged and NOT persisted — a 4xx here would tell the provider
    // to stop sending a category of event we may want later.
    if (event.type !== SUPPORTED_EVENT_TYPE) {
      this.logger.debug(`Ignoring unsupported event type ${event.type}`);

      return { received: true };
    }

    // Task 7 applies state here.
    return { received: true };
  }

  private verify(
    request: RawBodyRequest<Request>,
    signature: string | undefined,
  ): ProviderEvent {
    const rawBody = request.rawBody;

    if (rawBody === undefined) {
      // NOT a BadRequestException. An absent raw body means the application
      // was constructed without NEST_APP_OPTIONS, i.e. signature verification
      // is structurally impossible. That is a server misconfiguration and
      // must be a loud, logged 500 — never a fallback to an empty buffer, and
      // never a skipped check.
      throw new Error(
        'Request raw body is unavailable: the application was constructed ' +
          'without rawBody support (see NEST_APP_OPTIONS in src/bootstrap.ts)',
      );
    }

    if (signature === undefined || signature === '') {
      throw new BadRequestException('Invalid signature');
    }

    try {
      return this.provider.verifyWebhook(rawBody, signature);
    } catch (error: unknown) {
      // Logged, never returned: "timestamp too old" versus "digest mismatch"
      // tells an attacker which half to fix. The client sees one bare message.
      this.logger.warn(
        `Rejected webhook delivery: ${error instanceof Error ? error.message : 'unknown error'}`,
      );

      throw new BadRequestException('Invalid signature');
    }
  }
}
```

**Note:** the `stripe-signature` header name is the provider's, read in the one adapter-facing place. If a second provider ever ships, this becomes a port concern; with one configured provider it is not worth an abstraction today.

**Note on the `try/catch`:** it wraps a **provider** call, not a Prisma call. The "Prisma errors are never caught" rule is untouched.

- [ ] **Step 4: Register the controller**

In `src/modules/payments/payments.module.ts`, add `PaymentsWebhookController` to `controllers`.

- [ ] **Step 5: Run the unit tests and watch them pass**

Run: `npx jest src/modules/payments --silent`
Expected: PASS.

- [ ] **Step 6: Write the e2e suite — including the raw-body regression**

Create `test/payments-webhook.e2e-spec.ts`. Task 7 appends state assertions to this same file.

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { PAYMENT_PROVIDER, SUPPORTED_EVENT_TYPE } from '../src/modules/payments/provider/payment-provider';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';

describe('Payment webhook — signature boundary (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    provider.reset();
  });

  function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: 'evt_1',
      type: SUPPORTED_EVENT_TYPE,
      providerPaymentId: 'pi_1',
      orderId: '0195f0a0-0000-7000-8000-0000000000aa',
      amountMinorUnits: 1000,
      currency: 'usd',
      ...overrides,
    });
  }

  const deliver = (body: string, signature: string | null) => {
    const call = request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json');

    return (signature === null ? call : call.set('stripe-signature', signature))
      .send(body);
  };

  it('accepts a correctly signed delivery with 200', async () => {
    const body = payload();

    const response = await deliver(body, provider.signWebhook(body)).expect(200);

    expect(response.body as Record<string, unknown>).toEqual({ received: true });
  });

  it('rejects a delivery with no signature header', async () => {
    await deliver(payload(), null).expect(400);
  });

  it('rejects a delivery with a wrong signature', async () => {
    await deliver(payload(), 'a'.repeat(64)).expect(400);
  });

  it('rejects a body that was tampered with after signing', async () => {
    const signature = provider.signWebhook(payload());

    await deliver(payload({ amountMinorUnits: 1 }), signature).expect(400);
  });

  it('rejects a correctly signed but unusable payload', async () => {
    const body = '{"id":"evt_2"}';

    await deliver(body, provider.signWebhook(body)).expect(400);
  });

  it('acknowledges a signed event of an unsupported type without persisting it', async () => {
    const body = payload({ type: 'payment_intent.payment_failed' });

    await deliver(body, provider.signWebhook(body)).expect(200);

    expect(await prisma.paymentEvent.count()).toBe(0);
  });

  it('requires no authentication — @Public() is what makes delivery possible', async () => {
    const body = payload();

    // No Authorization header anywhere in this suite; a 401 here would mean
    // @Public() was dropped and no order could ever be paid.
    await deliver(body, provider.signWebhook(body)).expect(200);
  });

  /**
   * THE RAW-BODY REGRESSION.
   *
   * This payload survives JSON.parse but NOT a parse/re-stringify round trip:
   * the key order and the spacing both change, and so does the HMAC. If
   * anything ever verifies against a re-serialised body — or if
   * NEST_APP_OPTIONS stops reaching the app — this signature stops matching
   * and the test fails. Without it, that breakage looks like a signing bug.
   */
  it('verifies against the exact bytes sent, not a re-serialised body', async () => {
    const body = '{"z":1,  "type":"' + SUPPORTED_EVENT_TYPE + '","id":"evt_3",' +
      '"providerPaymentId":"pi_3","orderId":"0195f0a0-0000-7000-8000-0000000000ab",' +
      '"amountMinorUnits":1000,"currency":"usd"}';

    expect(JSON.stringify(JSON.parse(body))).not.toBe(body);

    await deliver(body, provider.signWebhook(body)).expect(200);
  });
});
```

- [ ] **Step 7: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS. A 401 on the "requires no authentication" case means `@Public()` is missing; a 400 on the raw-body regression means `NEST_APP_OPTIONS` is not reaching the test app.

- [ ] **Step 8: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 9: Commit**

```bash
git add src/modules/payments test/payments-webhook.e2e-spec.ts
git commit -m "feat(payments): add the signature-verified webhook endpoint

POST /api/v1/payments/webhook, in its own @Public() controller so that
decorator never sits beside a bearer-authenticated money route. The signature
over request.rawBody is the endpoint's only authentication.

Throttled explicitly at 300/min under the `default` key rather than skipped:
one provider's deliveries share a small IP set, so the global per-handler
limit would throttle legitimate bursts, but an unauthenticated endpoint doing
HMAC and database work should not be unprotected.

Only an invalid signature or an unusable payload is 4xx; a signed event of an
unsupported type is acknowledged with 200 and not persisted. A missing
rawBody throws a loud 500 rather than falling back to an empty buffer -
silently unverified deliveries are the worst failure available here.

The e2e suite includes a raw-body regression whose payload does not survive a
parse/re-stringify round trip, so any future re-serialisation breaks it
immediately instead of looking like a signing bug.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Webhook state application

**Objective:** Implement spec §8.2 exactly — one short `ReadCommitted` transaction containing event dedupe, order lookup, amount/currency validation, payment promotion and the `markPaid` CAS, with signature verification already done outside it.

**Files:**
- Create: `src/modules/payments/payment-webhook.service.ts`
- Create: `src/modules/payments/payment-webhook.service.spec.ts`
- Modify: `src/modules/payments/payments-webhook.controller.ts`
- Modify: `src/modules/payments/payments-webhook.controller.spec.ts`
- Modify: `src/modules/payments/payments.module.ts`
- Test: `test/payments-webhook.e2e-spec.ts` (append a state `describe`)

**Interfaces:**
- Consumes: `OrdersService.markPaid` (Task 4), `ProviderEvent` (Task 2), `PrismaService`.
- Produces: `PaymentWebhookService.apply(event: ProviderEvent): Promise<void>`.

**What must NOT be changed in this task:** the controller's verification path (Task 6), `OrdersService` (Task 4 finished it), `HttpExceptionFilter`, `prisma/`.

**Database implications:** writes `payment_events` and `payments`; writes `orders` **only** through `OrdersService.markPaid`. No schema change.

**The two rules that make this task's code look odd if you skip the spec:**

1. **The order is resolved from `event.orderId`** — which came from the provider's signed metadata — **never from a `providerPaymentId` lookup** (S5). Initiation's local insert may not have committed yet; keying off metadata makes the webhook independent of it (P4).
2. **`skipDuplicates` on `payments` is ambiguous** because that table has two unique columns. The insert is followed by a conditional `updateMany`, and *neither* result is treated as authoritative on its own (§8.3, §11.5).

- [ ] **Step 1: Write the failing service unit tests**

Create `src/modules/payments/payment-webhook.service.spec.ts`:

```ts
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService, MarkPaidOutcome } from '../orders/orders.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { ProviderEvent, SUPPORTED_EVENT_TYPE } from './provider/payment-provider';

const EVENT: ProviderEvent = {
  providerEventId: 'evt_1',
  type: SUPPORTED_EVENT_TYPE,
  providerPaymentId: 'pi_1',
  orderId: 'order-1',
  amountMinorUnits: 1000,
  currency: 'USD',
};

describe('PaymentWebhookService.apply', () => {
  let service: PaymentWebhookService;
  let tx: {
    paymentEvent: { createMany: jest.Mock<Promise<{ count: number }>, [unknown]> };
    order: { findUnique: jest.Mock<Promise<unknown>, [unknown]> };
    payment: {
      createMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
      updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
  };
  let prisma: { $transaction: jest.Mock<Promise<unknown>, [unknown, unknown?]> };
  let orders: { markPaid: jest.Mock<Promise<MarkPaidOutcome>, [unknown, string]> };

  beforeEach(() => {
    tx = {
      paymentEvent: {
        createMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
      order: {
        findUnique: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
          id: 'order-1',
          status: OrderStatus.PENDING,
          totalCents: 1000,
          currency: 'USD',
        }),
      },
      payment: {
        createMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
        updateMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 0 }),
      },
    };
    prisma = {
      $transaction: jest
        .fn<Promise<unknown>, [unknown, unknown?]>()
        .mockImplementation((callback: unknown) =>
          (callback as (client: unknown) => Promise<unknown>)(tx),
        ),
    };
    orders = {
      markPaid: jest
        .fn<Promise<MarkPaidOutcome>, [unknown, string]>()
        .mockResolvedValue('paid'),
    };

    service = new PaymentWebhookService(
      prisma as unknown as PrismaService,
      orders as unknown as OrdersService,
    );
  });

  describe('dedupe', () => {
    it('inserts the event with skipDuplicates', async () => {
      await service.apply(EVENT);

      const args = tx.paymentEvent.createMany.mock.calls[0][0] as {
        data: { providerEventId: string; type: string };
        skipDuplicates: boolean;
      };

      expect(args.data.providerEventId).toBe('evt_1');
      expect(args.data.type).toBe(SUPPORTED_EVENT_TYPE);
      expect(args.skipDuplicates).toBe(true);
    });

    // payment_events has ONE unique column, so count === 0 is unambiguous.
    it('stops immediately on a duplicate delivery', async () => {
      tx.paymentEvent.createMany.mockResolvedValue({ count: 0 });

      await service.apply(EVENT);

      expect(tx.order.findUnique).not.toHaveBeenCalled();
      expect(orders.markPaid).not.toHaveBeenCalled();
    });
  });

  describe('order resolution', () => {
    // S5: from the SIGNED metadata, never a providerPaymentId lookup.
    it('resolves the order from the event orderId', async () => {
      await service.apply(EVENT);

      expect(tx.order.findUnique.mock.calls[0][0]).toEqual(
        expect.objectContaining({ where: { id: 'order-1' } }),
      );
    });

    it('records the event and marks nothing paid for an unknown order', async () => {
      tx.order.findUnique.mockResolvedValue(null);

      await service.apply(EVENT);

      expect(orders.markPaid).not.toHaveBeenCalled();
      expect(tx.payment.createMany).not.toHaveBeenCalled();
    });
  });

  describe('amount and currency', () => {
    it('does not mark paid when the amount disagrees with the order', async () => {
      tx.order.findUnique.mockResolvedValue({
        id: 'order-1',
        status: OrderStatus.PENDING,
        totalCents: 999,
        currency: 'USD',
      });

      await service.apply(EVENT);

      expect(orders.markPaid).not.toHaveBeenCalled();
    });

    it('does not mark paid when the currency disagrees', async () => {
      tx.order.findUnique.mockResolvedValue({
        id: 'order-1',
        status: OrderStatus.PENDING,
        totalCents: 1000,
        currency: 'GBP',
      });

      await service.apply(EVENT);

      expect(orders.markPaid).not.toHaveBeenCalled();
    });

    // C8: the adapter already uppercased, so this is a plain === on both
    // sides. If it ever fails, normalisation moved out of the adapter.
    it('accepts a matching uppercase currency', async () => {
      await service.apply(EVENT);

      expect(orders.markPaid).toHaveBeenCalled();
    });
  });

  describe('payment row (§8.3)', () => {
    it('inserts a SUCCEEDED payment when none exists', async () => {
      await service.apply(EVENT);

      const args = tx.payment.createMany.mock.calls[0][0] as {
        data: { orderId: string; providerPaymentId: string; status: PaymentStatus };
        skipDuplicates: boolean;
      };

      expect(args.data).toEqual(
        expect.objectContaining({
          orderId: 'order-1',
          providerPaymentId: 'pi_1',
          status: PaymentStatus.SUCCEEDED,
        }),
      );
      expect(args.skipDuplicates).toBe(true);
    });

    // The conditional update is a CAS: a duplicate cannot rewrite succeededAt.
    it('promotes an existing PENDING row with a status predicate', async () => {
      tx.payment.createMany.mockResolvedValue({ count: 0 });
      tx.payment.updateMany.mockResolvedValue({ count: 1 });

      await service.apply(EVENT);

      const args = tx.payment.updateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };

      expect(args.where).toEqual({
        orderId: 'order-1',
        providerPaymentId: 'pi_1',
        status: PaymentStatus.PENDING,
      });
    });

    // The orphan case: a row exists for this order under a DIFFERENT intent.
    // Both writes no-op, and the order is STILL marked paid — the event is
    // authentic and the amount matches. Refusing money that was taken would
    // be worse than recording a divergence.
    it('still marks the order paid when the persisted intent differs', async () => {
      tx.payment.createMany.mockResolvedValue({ count: 0 });
      tx.payment.updateMany.mockResolvedValue({ count: 0 });

      await service.apply(EVENT);

      expect(orders.markPaid).toHaveBeenCalledWith(tx, 'order-1');
    });
  });

  describe('the order CAS', () => {
    it('delegates to OrdersService.markPaid with the transaction client', async () => {
      await service.apply(EVENT);

      expect(orders.markPaid).toHaveBeenCalledWith(tx, 'order-1');
    });

    it.each<MarkPaidOutcome>(['paid', 'already-paid', 'cancelled', 'not-found'])(
      'never throws on outcome %s',
      async (outcome) => {
        orders.markPaid.mockResolvedValue(outcome);

        await expect(service.apply(EVENT)).resolves.toBeUndefined();
      },
    );
  });

  describe('transaction boundary', () => {
    it('does all of its work inside ONE transaction', async () => {
      await service.apply(EVENT);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    // The order write goes through OrdersService.markPaid, which owns the
    // table (D9). The mock deliberately exposes ONLY findUnique on tx.order,
    // so any direct tx.order.updateMany/update in the service would throw
    // "is not a function" and fail every test in this file — a real signal,
    // not a tautology. The structural grep in Task 10 covers it too.
    it('reads the order but routes the write through OrdersService', async () => {
      await service.apply(EVENT);

      expect(tx.order.findUnique).toHaveBeenCalledTimes(1);
      expect(orders.markPaid).toHaveBeenCalledWith(tx, 'order-1');
    });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/modules/payments/payment-webhook --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `PaymentWebhookService`**

Create `src/modules/payments/payment-webhook.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { ProviderEvent } from './provider/payment-provider';

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
  ) {}

  /**
   * Spec §8.2. ONE transaction, entered only after the signature has already
   * been verified OUTSIDE it — the same rule as Phase 1's "never hold a lock
   * across JWT signing" and Phase 3's "no argon2 inside checkout", restated
   * for the money path.
   *
   * NOTHING IN HERE CALLS THE PROVIDER. The port takes no transaction client
   * precisely so that this cannot be done by accident.
   *
   * It never throws for a business reason. Every outcome below commits the
   * event row and returns, so the controller answers 200 and the provider
   * stops retrying. Only a genuine database failure escapes — and that SHOULD
   * escape, because a 500 is what makes the provider retry later.
   */
  async apply(event: ProviderEvent): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // 1. Dedupe. payment_events has exactly ONE unique column, so
        //    count === 0 unambiguously means "already delivered". No P2002 is
        //    raised and nothing is caught: the predicate travels with the
        //    write, the same idiom as ProductsService.decrementStock().
        const { count } = await tx.paymentEvent.createMany({
          data: { providerEventId: event.providerEventId, type: event.type },
          skipDuplicates: true,
        });

        if (count === 0) {
          this.logger.debug(`Duplicate delivery ${event.providerEventId}`);

          return;
        }

        // 2. Resolve the order from the SIGNED metadata, never by looking up
        //    providerPaymentId. Initiation's local insert may not have
        //    committed yet; this keeps the webhook independent of it (S5, P4).
        const order = await tx.order.findUnique({
          where: { id: event.orderId },
          select: { id: true, totalCents: true, currency: true },
        });

        if (order === null) {
          // Recorded and acknowledged. A 4xx would make the provider stop
          // retrying an event we may need; a retry would not help either,
          // because the order genuinely does not exist here.
          this.logger.error(
            `Webhook ${event.providerEventId} references unknown order ${event.orderId}`,
          );

          return;
        }

        // 3. The provider tells us an amount; we believe the database.
        //    Both sides are uppercase: the adapter normalised on the way in.
        if (
          event.amountMinorUnits !== order.totalCents ||
          event.currency !== order.currency
        ) {
          this.logger.error(
            `Webhook ${event.providerEventId} amount/currency ` +
              `${event.amountMinorUnits} ${event.currency} does not match order ` +
              `${order.id} (${order.totalCents} ${order.currency}); not marking paid`,
          );

          return;
        }

        await this.recordPayment(tx, event);

        // 4. The ONLY writer of PAID, and it lives in OrdersModule (D9).
        const outcome = await this.ordersService.markPaid(tx, order.id);

        if (outcome === 'cancelled') {
          // The reconciliation state: money was taken for an order that was
          // already cancelled and whose stock has been restored. Phase 4 does
          // NOT refund it (docs/deferred-limitations.md). Recorded loudly and
          // acknowledged, so the provider stops retrying.
          this.logger.error(
            `Payment succeeded for CANCELLED order ${order.id} ` +
              `(event ${event.providerEventId}); manual refund required`,
          );
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  /**
   * Spec §8.3. Three correct outcomes:
   *
   *  - no row existed (the webhook beat initiation): the insert creates it
   *    already SUCCEEDED;
   *  - a matching PENDING row existed: the insert no-ops and the conditional
   *    update promotes it exactly once;
   *  - a row existed under a DIFFERENT providerPaymentId (a confirmed orphan
   *    intent): both statements no-op, and the caller still marks the order
   *    paid, because the event is authentic and the amount matches.
   *
   * `count` is never trusted on its own: `payments` has TWO unique columns
   * (orderId, providerPaymentId), so skipDuplicates does not say which one
   * fired. The conditional update carries its own predicate instead, and it
   * is a CAS on status: PENDING so a duplicate cannot rewrite succeededAt.
   */
  private async recordPayment(
    tx: Prisma.TransactionClient,
    event: ProviderEvent,
  ): Promise<void> {
    const succeededAt = new Date();

    const { count: inserted } = await tx.payment.createMany({
      data: {
        orderId: event.orderId,
        providerPaymentId: event.providerPaymentId,
        status: PaymentStatus.SUCCEEDED,
        succeededAt,
      },
      skipDuplicates: true,
    });

    if (inserted === 1) {
      return;
    }

    const { count: promoted } = await tx.payment.updateMany({
      where: {
        orderId: event.orderId,
        providerPaymentId: event.providerPaymentId,
        status: PaymentStatus.PENDING,
      },
      data: { status: PaymentStatus.SUCCEEDED, succeededAt },
    });

    if (promoted === 0) {
      this.logger.warn(
        `Order ${event.orderId} has a payment row under a different intent ` +
          `than ${event.providerPaymentId}; recording the order as paid anyway`,
      );
    }
  }
}
```

- [ ] **Step 4: Call the service from the controller**

In `src/modules/payments/payments-webhook.controller.ts`, inject `PaymentWebhookService`, make `handle` `async`, and replace the Task 6 placeholder:

```ts
    await this.webhookService.apply(event);

    return { received: true };
```

Update `payments-webhook.controller.spec.ts`: construct the controller with a stubbed `PaymentWebhookService` whose `apply` is `jest.fn<Promise<void>, [ProviderEvent]>().mockResolvedValue(undefined)`, `await` every `handle` call, and add two cases:

```ts
  it('applies a supported event', async () => {
    await controller.handle(requestWith(Buffer.from('{}')), 'sig');

    expect(webhookService.apply).toHaveBeenCalledWith(EVENT);
  });

  it('does NOT apply an unsupported event type', async () => {
    provider.verifyWebhook.mockReturnValue({ ...EVENT, type: 'other.type' });

    await controller.handle(requestWith(Buffer.from('{}')), 'sig');

    expect(webhookService.apply).not.toHaveBeenCalled();
  });
```

- [ ] **Step 5: Register the service**

In `src/modules/payments/payments.module.ts`, add `OrdersModule` to `imports` and `PaymentWebhookService` to `providers`.

```ts
import { OrdersModule } from '../orders/orders.module';
```

- [ ] **Step 6: Run the unit tests and watch them pass**

Run: `npx jest src/modules/payments --silent`
Expected: PASS.

- [ ] **Step 7: Append the state matrix to the webhook e2e suite**

Append to `test/payments-webhook.e2e-spec.ts`. **Every paid order in this suite is reached through a signed event** — a factory that wrote `status: PAID` directly would prove nothing about the pipeline under test (spec §15.2).

```ts
// Add these imports at the top of the file, beside Task 6's:
//   import { TokenService } from '../src/modules/auth/token.service';
//   import { assertStockConserved } from './helpers/assert-stock-conserved';
//   import { createUser } from './factories/user.factory';
//   import { createCategory } from './factories/category.factory';
//   import { createProduct } from './factories/product.factory';
//   import { createOrder } from './factories/order.factory';

describe('Payment webhook — state application (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // In-memory provider state; truncateAll does not touch it.
    provider.reset();
  });

  async function paidCandidate(totalCents = 1000) {
    const user = await createUser(prisma);
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      priceCents: totalCents,
      stockQuantity: 10,
    });
    const order = await createOrder(prisma, user.id, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: totalCents,
        quantity: 1,
      },
    ]);

    // Mirror what checkout would have done to stock, so conservation holds.
    await prisma.product.update({
      where: { id: product.id },
      data: { stockQuantity: 9 },
    });

    return { user, product, order };
  }

  function eventFor(
    order: { id: string; totalCents: number },
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      id: `evt_${order.id}`,
      type: SUPPORTED_EVENT_TYPE,
      providerPaymentId: `pi_${order.id}`,
      orderId: order.id,
      amountMinorUnits: order.totalCents,
      currency: 'usd',
      ...overrides,
    });
  }

  const send = (body: string) =>
    request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', provider.signWebhook(body))
      .send(body);

  it('marks a PENDING order PAID and records the payment and the event', async () => {
    const { order } = await paidCandidate();

    await send(eventFor(order)).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe('PAID');
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.succeededAt).not.toBeNull();
    expect(await prisma.paymentEvent.count()).toBe(1);
  });

  it('never changes stock when an order is paid', async () => {
    const { order, product } = await paidCandidate();

    await send(eventFor(order)).expect(200);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    expect(after.stockQuantity).toBe(9);
    // A PAID order still holds its unit: 9 remaining + 1 held = 10.
    await assertStockConserved(prisma, product.id, 10);
  });

  it('is idempotent across a repeated delivery of the same event', async () => {
    const { order } = await paidCandidate();
    const body = eventFor(order);

    await send(body).expect(200);
    const first = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    await send(body).expect(200);
    const second = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(await prisma.paymentEvent.count()).toBe(1);
    expect(second.succeededAt).toEqual(first.succeededAt);
  });

  it('records an event for an unknown order without changing anything', async () => {
    const body = eventFor({
      id: '0195f0a0-0000-7000-8000-0000000000cc',
      totalCents: 1000,
    });

    await send(body).expect(200);

    expect(await prisma.paymentEvent.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('records but does not pay on an amount mismatch', async () => {
    const { order } = await paidCandidate();

    await send(eventFor(order, { amountMinorUnits: 999 })).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

    expect(reread.status).toBe('PENDING');
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.paymentEvent.count()).toBe(1);
  });

  it('records but does not pay on a currency mismatch', async () => {
    const { order } = await paidCandidate();

    await send(eventFor(order, { currency: 'gbp' })).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

    expect(reread.status).toBe('PENDING');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('leaves a CANCELLED order cancelled but records the payment as SUCCEEDED', async () => {
    const { order } = await paidCandidate();

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    await send(eventFor(order)).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe('CANCELLED');
    expect(payment.status).toBe('SUCCEEDED');
  });

  it('promotes a PENDING payment row created by initiation', async () => {
    const { order, user } = await paidCandidate();
    const token = await app.get(TokenService).signAccessToken(user);

    const initiated = await request(app.getHttpServer())
      .post(`/api/v1/orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const stored = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    await send(
      eventFor(order, { providerPaymentId: stored.providerPaymentId }),
    ).expect(200);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(payment.id).toBe(stored.id);
    expect(payment.status).toBe('SUCCEEDED');
    expect((initiated.body as { id: string }).id).toBe(stored.id);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('refuses a later initiation once the order is paid', async () => {
    const { order, user } = await paidCandidate();
    const token = await app.get(TokenService).signAccessToken(user);

    await send(eventFor(order)).expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });
});
```

- [ ] **Step 8: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 9: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 10: Commit**

```bash
git add src/modules/payments test/payments-webhook.e2e-spec.ts
git commit -m "feat(payments): apply webhook state in one short transaction

Signature verification stays outside; the transaction contains only event
dedupe, the order lookup, the amount/currency check, the payment promotion
and the markPaid CAS. No provider call can occur inside it - the port takes
no transaction client, so it cannot be done by accident.

The order is resolved from the signed metadata orderId, never from a
providerPaymentId lookup, so a webhook that overtakes initiation's local
insert still pays the right order.

createMany(skipDuplicates) dedupes events without catching P2002. On payments
the count is deliberately not trusted alone - that table has two unique
columns - so the insert is followed by a conditional update whose predicate
is a CAS on status: PENDING, and a row recorded under a different intent
still marks the order paid because the event is authentic.

Every non-state outcome commits the event row and returns 200 so the provider
stops retrying; only a genuine database failure escapes as a 500, which is
what makes the provider retry later.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Concurrency suite and recorded negative controls

**Objective:** Prove, under real parallel HTTP against real Postgres, the six claims Phase 4 rests on — and prove each is *load-bearing* by recording a naive implementation failing it first.

**Files:**
- Create: `test/payments-concurrency.e2e-spec.ts`
- Modify: `docs/superpowers/specs/2026-09-23-phase-4-payments-design.md` (§19 Evidence table only — fill cells, change nothing else)

**Interfaces:**
- Consumes: everything from Tasks 4–7.
- Produces: no source interface. Produces **evidence**.

**What must NOT be changed in this task:** anything under `src/`. Negative controls are applied by hand, observed, then reverted; **naive code is never committed**, and no test-only switch is added to `src/`.

**Harness rules — non-negotiable, all proven in Phase 3:**
- `await app.listen(0)` in `beforeAll`. An unlistened server makes supertest call `listen(0)` per request, which breaks under `Promise.all` with `ERR_SERVER_ALREADY_LISTEN`.
- `createTestApp([], { throttleLimit: 0 })`. It is a boolean trigger, not a cap; this suite far exceeds 300/min on the webhook handler.
- Tokens minted with `app.get(TokenService).signAccessToken(user)`, never `/auth/login`, so the 5/min auth throttle is never in the loop.
- `truncateAll(prisma)` **and** `provider.reset()` in `beforeEach` — the fake's state is in memory and truncation does not touch it.
- **Every test asserts no response is a 500.**
- The e2e advisory lock applies; only one `npm run test:e2e` may hold the database.

- [ ] **Step 1: Write the suite skeleton and shared helpers**

Create `test/payments-concurrency.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import {
  PAYMENT_PROVIDER,
  SUPPORTED_EVENT_TYPE,
} from '../src/modules/payments/provider/payment-provider';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { assertStockConserved } from './helpers/assert-stock-conserved';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { createOrder } from './factories/order.factory';

describe('Payments concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);

    // Required: supertest against an unlistened server calls listen(0) per
    // request, which throws ERR_SERVER_ALREADY_LISTEN under Promise.all.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    provider.reset();
  });

  async function scenario(totalCents = 1000, stock = 10) {
    const user = await createUser(prisma);
    const token = await tokens.signAccessToken(user);
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      priceCents: totalCents,
      stockQuantity: stock,
    });
    const order = await createOrder(prisma, user.id, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: totalCents,
        quantity: 1,
      },
    ]);

    // Mirror checkout's decrement so conservation is meaningful.
    await prisma.product.update({
      where: { id: product.id },
      data: { stockQuantity: stock - 1 },
    });

    return { user, token, product, order, initialStock: stock };
  }

  function eventBody(
    order: { id: string; totalCents: number },
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      id: `evt_${order.id}`,
      type: SUPPORTED_EVENT_TYPE,
      providerPaymentId: `pi_${order.id}`,
      orderId: order.id,
      amountMinorUnits: order.totalCents,
      currency: 'usd',
      ...overrides,
    });
  }

  const deliver = (body: string) =>
    request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', provider.signWebhook(body))
      .send(body);

  const initiate = (orderId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${token}`);

  interface PaymentBody {
    id: string;
    clientSecret: string;
  }

  const paymentBody = (response: { body: unknown }): PaymentBody =>
    response.body as PaymentBody;

  const statuses = (responses: { status: number }[]): Record<number, number> =>
    responses.reduce<Record<number, number>>((counts, response) => {
      counts[response.status] = (counts[response.status] ?? 0) + 1;

      return counts;
    }, {});

  // …P1–P4, I1, A1 below…
});
```

- [ ] **Step 2: Write P1 — duplicate webhook delivery**

```ts
  it('P1: 20 concurrent duplicate deliveries transition the order exactly once', async () => {
    const { order, product, initialStock } = await scenario();
    const body = eventBody(order);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => deliver(body)),
    );

    expect(statuses(responses)).toEqual({ 200: 20 });
    expect(responses.some((response) => response.status >= 500)).toBe(false);

    expect(await prisma.paymentEvent.count()).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe('PAID');
    expect(payment.status).toBe('SUCCEEDED');
    await assertStockConserved(prisma, product.id, initialStock);
  });
```

**Negative control (required):** in `PaymentWebhookService.apply`, replace the dedupe with a read-then-write:

```ts
// CONTROL — never committed
const existing = await tx.paymentEvent.findUnique({
  where: { providerEventId: event.providerEventId },
});
if (existing !== null) { return; }
await tx.paymentEvent.create({
  data: { providerEventId: event.providerEventId, type: event.type },
});
```

Run P1, capture the output, revert by hand, confirm `git diff src/` is empty, re-run to confirm green. Expect the control to produce duplicate-key 500s and/or more than one event row. **If it does not fail, the test is not racing hard enough — raise the delivery count and repeat. Do not accept a green control.**

- [ ] **Step 3: Write P2 — cancel racing webhook success**

```ts
  it('P2: a concurrent cancel and webhook success resolve to exactly one legal outcome', async () => {
    const { order, token, product, initialStock } = await scenario();

    const [cancel, webhook] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set('Authorization', `Bearer ${token}`),
      deliver(eventBody(order)),
    ]);

    expect(webhook.status).toBe(200);
    expect([200, 409]).toContain(cancel.status);
    expect(cancel.status).toBeLessThan(500);

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    if (reread.status === 'PAID') {
      // Payment won: stock stays sold, and the cancel must have been refused.
      expect(after.stockQuantity).toBe(initialStock - 1);
      expect(cancel.status).toBe(409);
    } else {
      // Cancel won: stock restored exactly once, and the late payment is
      // recorded as SUCCEEDED for reconciliation but the order stays
      // CANCELLED.
      expect(reread.status).toBe('CANCELLED');
      expect(after.stockQuantity).toBe(initialStock);
      expect(cancel.status).toBe(200);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { orderId: order.id },
      });

      expect(payment.status).toBe('SUCCEEDED');
    }

    // Never both: PAID with restored stock is the corruption this guards.
    expect(
      reread.status === 'PAID' && after.stockQuantity === initialStock,
    ).toBe(false);

    await assertStockConserved(prisma, product.id, initialStock);
  });
```

**Negative control (required):** remove `status: OrderStatus.PENDING` from `markPaid`'s `updateMany` predicate. Expect a run where the order ends `PAID` *and* stock was restored — the exact corruption. Capture, revert, re-run green.

- [ ] **Step 4: Write P3 — concurrent initiation**

```ts
  it('P3: 15 concurrent initiations create exactly one payment and one intent', async () => {
    const { order, token } = await scenario();

    const responses = await Promise.all(
      Array.from({ length: 15 }, () => initiate(order.id, token)),
    );

    expect(responses.some((response) => response.status >= 500)).toBe(false);
    expect(statuses(responses)).toEqual({ 201: 1, 200: 14 });

    // The provider itself created exactly one intent for this key.
    expect(provider.createCountFor(order.id)).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);

    const secrets = new Set(
      responses.map((response) => paymentBody(response).clientSecret),
    );
    const ids = new Set(responses.map((response) => paymentBody(response).id));

    expect(secrets.size).toBe(1);
    expect(ids.size).toBe(1);
  });
```

**Negative control (required):** in `PaymentsService.initiate`, replace `idempotencyKey: order.id` with a random value (`idempotencyKey: randomUUID()`). Expect `provider.createCountFor(order.id)` to exceed 1 — several orphaned intents for one order. Capture, revert, re-run green.

- [ ] **Step 5: Write P4 — webhook before the local payment write**

```ts
  it('P4: a webhook that arrives before initiation still pays the right order', async () => {
    const { order, token } = await scenario();

    // The webhook is delivered for an intent the database has never seen —
    // exactly the state during the window between the provider accepting a
    // create and our row committing.
    const [webhook, initiation] = await Promise.all([
      deliver(eventBody(order, { providerPaymentId: 'pi_from_provider_first' })),
      initiate(order.id, token),
    ]);

    expect(webhook.status).toBe(200);
    expect(initiation.status).toBeLessThan(500);
    // Initiation either wins the race (201/200) or finds the order already
    // paid (409). Both are correct; nothing else is.
    expect([200, 201, 409]).toContain(initiation.status);

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

    expect(reread.status).toBe('PAID');
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.paymentEvent.count()).toBe(1);
  });

  it('P4b: a webhook for an order with no payment row at all still pays it', async () => {
    const { order } = await scenario();

    await deliver(
      eventBody(order, { providerPaymentId: 'pi_never_initiated' }),
    ).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe('PAID');
    expect(payment.providerPaymentId).toBe('pi_never_initiated');
    expect(payment.status).toBe('SUCCEEDED');
  });
```

**Negative control (required):** in `PaymentWebhookService.apply`, resolve the order by payment lookup instead of signed metadata:

```ts
// CONTROL — never committed
const found = await tx.payment.findUnique({
  where: { providerPaymentId: event.providerPaymentId },
});
if (found === null) { return; }
const order = await tx.order.findUnique({ where: { id: found.orderId }, ... });
```

Expect P4b to leave the order `PENDING`. Capture, revert, re-run green.

- [ ] **Step 6: Write I1 — the idempotency-retention resolution (C3)**

```ts
  it('I1: after provider key retention expires, replay returns the PERSISTED intent', async () => {
    const { order, token } = await scenario();

    const first = await initiate(order.id, token).expect(201);
    const stored = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    // The provider prunes its idempotency keys. The same key would now yield
    // a NEW intent — which is exactly why the local row, not the key, is the
    // durable guarantee (C3).
    provider.expireIdempotencyKeys();

    const replays = await Promise.all([
      initiate(order.id, token),
      initiate(order.id, token),
      initiate(order.id, token),
    ]);

    expect(statuses(replays)).toEqual({ 200: 3 });
    expect(replays.some((response) => response.status >= 500)).toBe(false);

    for (const replay of replays) {
      expect(paymentBody(replay).clientSecret).toBe(
        paymentBody(first).clientSecret,
      );
      // The returned secret belongs to the intent we actually persisted.
      expect(paymentBody(replay).clientSecret).toContain(
        stored.providerPaymentId,
      );
    }

    // No second intent was ever created at the provider.
    expect(provider.createCountFor(order.id)).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);

    const reread = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.providerPaymentId).toBe(stored.providerPaymentId);
  });
```

**Negative control (required):** delete the `payment.findUnique` short-circuit in `initiate` (step 3 of §7.3), so the service always calls `createPayment`. Expect `createCountFor` to reach 2 and the returned `clientSecret` **not** to contain the persisted `providerPaymentId` — the precise correctness bug C3 describes. Capture, revert, re-run green.

- [ ] **Step 7: Write A1 — the payable-range boundary**

```ts
  it('A1: an unpayable total is refused before any intent is created', async () => {
    const above = await scenario(100_000_000);
    const below = await scenario(49);

    const [tooBig, tooSmall] = await Promise.all([
      initiate(above.order.id, above.token),
      initiate(below.order.id, below.token),
    ]);

    expect(tooBig.status).toBe(422);
    expect(tooSmall.status).toBe(422);
    expect(provider.createCountFor(above.order.id)).toBe(0);
    expect(provider.createCountFor(below.order.id)).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('A1b: the exact boundary values are payable', async () => {
    const min = await scenario(50);
    const max = await scenario(99_999_999);

    await initiate(min.order.id, min.token).expect(201);
    await initiate(max.order.id, max.token).expect(201);
  });
```

**Negative control (required):** move the `amountLimits` check to *after* `createPayment`. Expect `createCountFor` to be 1 for the unpayable order — an intent created for an order that can never be paid. Capture, revert, re-run green.

- [ ] **Step 8: Run the suite three times**

```bash
npm run test:e2e -- --testPathPattern payments-concurrency
npm run test:e2e -- --testPathPattern payments-concurrency
npm run test:e2e -- --testPathPattern payments-concurrency
```

Expected: green all three times, with **zero** 500s and zero `40P01` in the Postgres log. An intermittent failure is a real defect — investigate it, never re-run until green.

- [ ] **Step 9: Fill in the spec's §19 Evidence table**

Open `docs/superpowers/specs/2026-09-23-phase-4-payments-design.md` and fill the P1, P2, P3, P4, I1 and A1 rows with the naive implementation used, its captured failing output, and the passing output. Record the emitted dedupe SQL row if Prisma query logging was enabled.

**Change nothing else in the spec.** If a control could not be made to fail, record that honestly — with what was tried and how hard — exactly as Phase 3's C3 row does, and say plainly what the passing run does and does not prove. **A null result is recorded, never hidden, and never dressed up as a success.**

- [ ] **Step 10: Confirm `src/` is untouched**

```bash
git diff --stat src/
```

Expected: **empty**. Every negative control was reverted by hand.

- [ ] **Step 11: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 12: Commit**

```bash
git add test/payments-concurrency.e2e-spec.ts docs/superpowers/specs/2026-09-23-phase-4-payments-design.md
git commit -m "test(payments): add the concurrency suite and record its negative controls

P1 duplicate webhook delivery, P2 cancel racing webhook success, P3
concurrent initiation, P4 webhook arriving before the local payment write, I1
replay after provider key retention expires, A1 the payable-range boundary.

Each runs real parallel HTTP against real Postgres, asserts exact outcomes
and stock conservation, and asserts no response is a 500. Each is paired with
a recorded negative control that fails against the naive implementation it
protects; the captured output is in the spec's evidence table. No naive code
is committed and no test-only switch exists in src/.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Documentation

**Objective:** Record the conventions, the operator flow, and the limitations, so the next phase inherits decisions rather than rediscovering them.

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/deferred-limitations.md`

**What must NOT be changed in this task:** any file under `src/`, `test/`, or `prisma/`. Documentation only.

**The hard constraint on wording.** No document may imply that the backend confirms a payment, that refunds exist, that reconciliation is automatic, that `PENDING` orders expire, or that any Phase 5 capability is present. Where a limitation exists, say so plainly.

- [ ] **Step 1: Add a Phase 4 section to `CLAUDE.md`**

After the Phase 3 section, in the same voice. Cover, each as a short rule with its reason:

1. **The signature-verified webhook is the sole authority for `PENDING → PAID`.** `OrdersService.markPaid` is the only writer of `PAID`; `PaymentWebhookService` is its only caller. No confirm route, no `confirmPayment` provider method, no frontend — **completion is out-of-band (D11), and that is a demo boundary, not a shortcut around verification.**
2. **Dedupe is `createMany({ skipDuplicates: true })`, never a caught `P2002`.** Include *why*: letting `P2002` escape becomes a 409 and the provider retries forever; catching it violates the standing Prisma rule. Add the ambiguity note — `payments` has two unique columns, so `count` alone is never trusted; the row is read back and `providerPaymentId` compared.
3. **The local `Payment` row — not the provider idempotency key — is the durable guarantee.** Key retention is bounded; once a row exists the service calls `retrievePayment`, a lookup by id with no retention window.
4. **`NEST_APP_OPTIONS` in `src/bootstrap.ts` is the construction seam; `configureApp()` remains the configuration seam.** Both are consumed by `main.ts` and `create-test-app.ts`. No route-local `express.raw`. A missing `rawBody` throws rather than degrading.
5. **`PaymentProvider` methods take no `Prisma.TransactionClient`** — the inverse of `decrementStock(tx, …)`, and the type-level guarantee that no provider call happens inside a transaction.
6. **The Stripe API version is pinned and compiler-enforced** (`2026-08-26.dahlia` with `stripe@22.6.2`; the SDK types accept no other string).
7. **`PAYMENT_PROVIDER=fake` is rejected under `NODE_ENV=production` by Joi, at boot.** The fake is a real, config-selected implementation, not a test double.
8. **Not every `PENDING` order is payable.** The payable range is checked *before* any provider call and returns **422**; the maximum is the lowest documented provider tier because the payment method is unknown at initiation.
9. **Currency normalisation happens only in the adapter** — lowercase out, uppercase in.
10. **`assertStockConserved` counts `PAID` orders as holding stock.** A paid order's stock is never restored.
11. **Never log** the webhook secret, the API key, the signature header, the client secret, or the raw payload. `providerPaymentId` in logs is acceptable — it is an opaque reference, not a credential.

- [ ] **Step 2: Update `README.md`**

- Mark Payments ✅ in the phase list; set the current phase to **Phase 5**.
- Add both routes to the route table with their full status sets (201/200/400/401/404/409/422/502 for initiation; 200/400/429/500 for the webhook).
- Document the three new environment variables, including that `fake` is rejected in production.
- Add the **operator flow** (spec §7.5), stated so it cannot be read as the backend confirming anything:

> **Completing a payment.** This API creates a payment intent and returns its
> client secret; it never completes the payment. Boot with
> `PAYMENT_PROVIDER=stripe` and test-mode credentials, `POST /api/v1/orders`,
> then `POST /api/v1/orders/:id/payments`. Complete the returned intent with
> Stripe's own test tooling (CLI or test-mode dashboard). Stripe then delivers
> a signed `payment_intent.succeeded` to `POST /api/v1/payments/webhook`, and
> **only that verified webhook** marks the order `PAID`. `GET /api/v1/orders/:id`
> will then show `PAID`. There is deliberately no confirm endpoint.

- State plainly: **not every `PENDING` order can be paid** — totals outside the payable range return 422.

- [ ] **Step 3: Add five entries to `docs/deferred-limitations.md` and amend one**

Copy spec §17.1–§17.6 into the file's existing format. Each needs **owner**, **why deferred**, **what happens today**, **what a future phase must do**:

1. **A payment that succeeds after its order was cancelled is recorded but not refunded** — owner: unscheduled (refunds). Today: order stays `CANCELLED`, payment `SUCCEEDED`, error log, 200 to the provider; queryable as `payments.status = 'SUCCEEDED'` joined to `orders.status = 'CANCELLED'`.
2. **No automated reconciliation** — owner: Phase 5. Today: every divergence is logged at error level and is queryable, but nothing looks automatically.
3. **`payment_events` rows are never deleted** — owner: Phase 5, alongside the existing `refresh_tokens` purge. Disk growth, not latency.
4. **Real provider network behaviour is not covered by CI** — owner: unscheduled. Today: the fake covers the service layer; the Stripe adapter's verification is unit-tested offline; its HTTP behaviour is exercised only by hand against test mode.
5. **Not every `PENDING` order is payable** — owner: accepted by design. Today: 422 before any provider call; the order stays valid and cancellable.

Amend the existing **"PENDING orders hold stock indefinitely"** entry with one sentence: Phase 4 raises the rate at which such orders appear, because an abandoned payment attempt leaves a `PENDING` order behind. Mitigation and fix are unchanged. **Do not delete or weaken the entry.**

- [ ] **Step 4: Re-read every changed document against the wording constraint**

Grep your own output:

```bash
grep -rni "confirm\|refund\|reconcil\|expir" README.md CLAUDE.md docs/deferred-limitations.md
```

Every hit must be a statement that the capability is **absent**, **deferred**, or **out-of-band** — never a claim that it works.

- [ ] **Step 5: Run the full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/deferred-limitations.md
git commit -m "docs: record Phase 4 payment conventions and limitations

CLAUDE.md gains the Phase 4 rules: the webhook as sole authority for
PENDING -> PAID, createMany(skipDuplicates) as the dedupe idiom and why it is
not a caught P2002, the local Payment row as the durable idempotency
guarantee, NEST_APP_OPTIONS as the construction seam, the port's missing
transaction client as a structural no-I/O guarantee, the pinned API version,
the production fake-provider rejection, and the 422 payable-range contract.

README documents both routes with their full status sets, the three new
environment variables, and the out-of-band completion flow - stated so it
cannot be read as the backend confirming a payment.

Five new deferred limitations: refunds for cancelled-but-paid orders,
automated reconciliation, payment_events growth, uncovered provider network
behaviour, and the fact that not every PENDING order is payable. The existing
stock-holding entry is amended, not replaced.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Whole-phase review and closeout

**Objective:** Verify the shipped code against the spec item by item, run every phase-level gate, and check the Definition of Done line by line. **No new features.**

**Files:** none by default. Any fix found here is a bounded commit of its own with a `fix:` message.

- [ ] **Step 1: Spec-versus-code walk**

Read the spec end to end beside the code and confirm each: §4.3's interaction matrix (all eight rows), §7.3's nine-step algorithm, §7.4's nine cases, §8.2's ten-step pipeline, §8.5's eleven-row response contract, §9.5's status table, §10's four transaction diagrams, §11's exact field lists.

**Report any divergence; do not silently "fix" the spec.**

- [ ] **Step 2: Structural greps**

```bash
grep -rn "OrderStatus.PAID" src/          # only orders.service.ts markPaid
grep -rni "confirm" src/                  # no confirm route or provider method
grep -rn "P2002\|catch" src/modules/payments/   # only provider try/catch, never Prisma
grep -rn "\$transaction" src/modules/payments/  # only payment-webhook.service.ts
grep -rn "redis\|bullmq\|cron\|schedule" src/   # nothing
grep -rn "rawBody" src/                   # bootstrap.ts + the webhook controller
```

- [ ] **Step 3: Route inventory versus documentation**

Boot the app, fetch `/api/docs-json`, and confirm exactly **two** new routes exist — `POST /api/v1/orders/{id}/payments` and `POST /api/v1/payments/webhook` — each with `@ApiTags`, `@ApiOperation` and a documented response per status in §9.5. Confirm the README table matches.

- [ ] **Step 4: Migration versus schema**

```bash
docker compose down -v postgres-test && docker compose up -d postgres-test
npx prisma migrate deploy
npx prisma migrate status
```

Expected: all migrations applied, no drift.

- [ ] **Step 5: Phase-level gates**

```bash
npm run lint:ci
npm run build
npm test
npm run test:e2e
docker build -t ecommerce-backend:phase4 .
docker compose up -d postgres && docker compose ps
npm run build && node dist/scripts/bootstrap-admin.js && node dist/scripts/bootstrap-admin.js
```

The bootstrap must run **twice** against a fresh database and produce an unchanged `password_hash` — and it must boot at all, which is the check that Task 1's `PAYMENT_*` variables reached the bootstrap environment.

- [ ] **Step 6: Concurrency re-run**

Run `test/payments-concurrency.e2e-spec.ts` three more times. Confirm zero 500s and zero `40P01`. Confirm the spec's §19 evidence table has **no empty cell**; an empty cell means the corresponding claim is unproven and the phase is not done.

- [ ] **Step 7: Definition of Done, item by item**

Walk spec §20's 21 items and tick each against observed evidence — not against intent. Items 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16 and 20 each name a specific test or command; run it and record the result.

- [ ] **Step 8: Phase 5 scope check**

Confirm no scheduled job, queue, cache, expiry, refund path, or reconciliation sweep exists anywhere in `src/`, and that exactly one dependency (`stripe`) was added:

```bash
git diff master --stat -- package.json
```

- [ ] **Step 9: Report**

Produce a closeout summary: the Definition of Done table with evidence per row, the §19 evidence table, gate results, and anything deferred. **If any item fails, report it — do not re-scope the Definition of Done to match what shipped.**

---

## Phase 4 Definition of Done

Copied from spec §20 so this plan is self-contained. Every item is verified in Task 10.

1. One migration adds `OrderStatus.PAID`, `PaymentStatus`, and the `payments` and `payment_events` tables with the three unique constraints.
2. Both routes behave exactly as spec §9.4/§9.5/§7.3/§8.2 specify — every status code asserted by a test.
3. Another user's order returns **404** on initiation, asserted in e2e.
4. The webhook is the only code path that writes `PAID`, through `OrdersService.markPaid`; verified by grep and by unit tests.
5. Duplicate webhook delivery — sequential and concurrent — produces exactly one `payment_events` row and one transition (**P1**).
6. Concurrent initiation produces exactly one `Payment` row and one provider intent (**P3**).
7. A replay after simulated key-retention expiry returns the **persisted** intent (**I1**).
8. An order outside the payable range returns 422 with **zero** provider calls (**A1**).
9. Cancel-versus-webhook produces exactly one of the two legal outcomes, stock conserved (**P2**).
10. A bad signature returns 400 and leaves the order `PENDING`.
11. Paying never changes `stockQuantity`, asserted with `assertStockConserved`.
12. Cancelling a `PAID` order returns 409 and restores no stock; cancelling a `CANCELLED` order still returns 200.
13. **No provider call occurs inside any Prisma transaction**, proven by the structural test.
14. `CheckoutService` is unchanged; `OrdersService.cancel`'s CAS predicate is unchanged.
15. The app refuses to boot with `PAYMENT_PROVIDER=fake` under `NODE_ENV=production`, and refuses to boot without `PAYMENT_WEBHOOK_SECRET`.
16. CI is green with **no provider credentials configured**.
17. `npm run lint:ci`, `npm run build`, `npm test`, `npm run test:e2e` all green.
18. Spec §19 is complete and Task 9's documentation has landed.
19. **No Redis, no BullMQ, no scheduled or background job, no expiry logic, no refund code, no admin payment route**, and exactly one new runtime dependency (`stripe`).
20. **D11 holds in the shipped code:** no confirm route, no `confirmPayment`, no frontend, and no test-only path that reaches `PAID` without a verified signature. Exactly two new routes exist.
21. `README.md` documents the out-of-band completion flow using only routes that already exist.
