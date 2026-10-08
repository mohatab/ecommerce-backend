# Phase 5 — Scheduled Maintenance, Order Expiry, and Payment Reconciliation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the system time-based, system-initiated state correction — expiring abandoned `PENDING` orders and releasing their stock exactly once, purging two unbounded tables, and detecting payment divergence — with no new infrastructure.

**Architecture:** Three `@Cron` methods in a new `MaintenanceModule` delegate to service methods. Mutual exclusion is a `maintenance_leases` row claimed with the project's compare-and-swap idiom and **re-asserted inside the same transaction as every mutation** (fencing), so an instance that lost its lease cannot commit. Order expiry runs in two phases — provider reads outside any transaction, then one atomic transaction per order that transitions, stamps, fences, and restores all items together.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL 16, `@nestjs/schedule` (the single new runtime dependency), Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-10-06-phase-5-scheduled-maintenance-design.md` — the source of truth. Read it alongside this plan; every task argues from it.

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **No Redis, no BullMQ, no caching, no queue, and exactly one new runtime dependency (`@nestjs/schedule`).** Amended during implementation: `cron@4.4.0` is also *declared*, matching `@nestjs/schedule`'s own exact pin, because `addCronJob()` is typed in terms of `CronJob` and `@nestjs/schedule` does not re-export it. Zero packages were added to `node_modules`. See the design spec §18 item 28.
- **No `pg_advisory_lock` or `pg_try_advisory_xact_lock` for any maintenance job**, and no code may take `E2E_LOCK_KEY` (`728374651n`). The spec rejects advisory locks for the sweeps with reasons (§9.3.1); re-introducing one contradicts D6.
- **The webhook remains the sole writer of `OrderStatus.PAID`.** `markPaid()` is the only code in `src/` that writes it and `PaymentWebhookService` is its only caller. Phase 5 adds no writer.
- **The provider read is a veto, never an authority (D3).** It may prevent an expiry; it may never cause a transition to `PAID`.
- **Provider unavailable, timeout, or not-found → fail closed (D4).** Never expire an order whose provider status is unknown.
- **No external I/O inside a database transaction, ever.** Phase 4's absolute rule.
- **Reconciliation never mutates `orders`, `payments`, or `products` (D5).** It writes only `reconciliation_findings` and `maintenance_leases`.
- **No refunds, no reconciliation remediation, no confirm-payment route, no provider-listing capability.**
- **`src/config/` is the only place that reads `process.env`.** `.env.example` must stay in sync with every variable the app reads.
- **Adding a `default` arm to `markPaid()`'s `switch` is forbidden** — it defeats the tripwire for the next status.
- **No bespoke stock mutation path.** Expiry reuses `ProductsService.incrementStock(tx, productId, quantity)`.
- **`npm run lint:ci`, not `npm run lint`, is the gate** (`--max-warnings 0`, no autofix).
- Strict TypeScript; no `any` without a comment; explicit return types on public methods; DTOs with a static `from()`; Prisma errors never caught in a service or controller.
- `maxWorkers: 1` stays. Only one `npm run test:e2e` may hold the test database at a time.
- Baselines to increase, never reduce: **unit 325**, **e2e 249**.

---

## Review Focus

Five failure modes the spec implies that no task's tests would exercise by default. Each has a test assigned to the task owning the code.

1. **`truncateAll()` wipes the seeded `maintenance_leases` rows, so every e2e job silently reports `skipped: 'lease-held'` forever.** `truncateAll()` truncates every table in `public` except `_prisma_migrations`, and acquire is an `updateMany` that matches nothing when the row is gone. A reasonable person expects jobs to run in tests. → **Task 1** excludes the table and adds `resetLeases()`, with a test asserting a job runs after `truncateAll()`.
2. **`expiresAt` exactly equal to `now()`** — `<=` vs `<` decides whether an order expires on its deadline or one tick later. A reasonable person expects the deadline to be inclusive. → **Task 4** pins the boundary with an order whose `expiresAt` is exactly the query instant.
3. **A missing lease row in production** (manual deletion, a migration applied without its seed) makes the job unrunnable forever with no error — the acquire just matches zero. → **Task 1** logs at `error` (not `warn`) when the row is absent, distinguishing "absent" from "held", with a test.
4. **`ORDER_EXPIRY_TTL_MINUTES=0`** would set `expiresAt = now()` on every checkout and expire orders the instant they are created. → **Task 1** gives Joi a floor of `1`, with a test asserting boot fails at `0`.
5. **A multi-item order where restoration fails partway** must leave *no* units restored. The spec calls this the phase's most important invariant. → **Task 4** proves it positively (all items restored together) and **Task 7** proves it negatively (control C-E3).

---

## File Structure

**New module** — `src/modules/maintenance/`, owning its own controller, services, and DTOs like every other feature module:

| File | Responsibility |
|------|----------------|
| `maintenance.module.ts` | Wires the module; registers nothing global |
| `maintenance-lease.service.ts` | Acquire / heartbeat / release / fencing. **Nothing else.** |
| `maintenance-runner.service.ts` | Lease-wraps a job, times it, returns `JobSummary`. Owns the typed job `Record`. |
| `maintenance.scheduler.ts` | The three `@Cron` delegates. No logic. |
| `order-expiry.service.ts` | The two-phase sweep |
| `maintenance-purge.service.ts` | Both table purges |
| `payment-reconciliation.service.ts` | Candidate sets, finding classification |
| `reconciliation-finding.writer.ts` | The three-transition upsert lifecycle. Separated because it is the one piece with non-obvious semantics. |
| `admin-maintenance.controller.ts` | Both admin routes, one class-level `@Roles(Role.ADMIN)` |
| `maintenance-job-name.enum.ts` | The allowlist enum |
| `dto/run-job-params.dto.ts` | `@IsEnum` param validation |
| `dto/job-summary-response.dto.ts` | The safe summary |
| `dto/reconciliation-finding-response.dto.ts` | Finding DTO with `from()` |
| `dto/find-findings-query.dto.ts` | `kind` / `resolved` filters |

**Modified:** `prisma/schema.prisma` · one new migration · `src/config/configuration.ts` · `src/config/env.validation.ts` · `.env.example` · `src/app.module.ts` · `src/modules/orders/orders.service.ts` · `src/modules/orders/checkout.service.ts` · `src/modules/orders/dto/order-response.dto.ts` · `src/modules/orders/orders.module.ts` · `src/modules/payments/provider/payment-provider.ts` · `fake-payment.provider.ts` · `stripe-payment.provider.ts` · `src/modules/payments/payment-webhook.service.ts` · `test/helpers/truncate.ts` · `test/helpers/assert-stock-conserved.ts` · `README.md` · `CLAUDE.md` · `docs/deferred-limitations.md`

**Note on DTO date types:** the existing `OrderResponseDto` exposes `cancelledAt` as a raw `Date`, not an ISO string. The plan follows the codebase: `expiresAt` is `Date | null`. The spec's §11 wording ("ISO-8601") describes the serialized output, which Nest produces from a `Date`.

---

## Task Dependency Order

```
Task 1 (schema, config, lease + fencing)
   ├─► Task 2 (EXPIRED lifecycle) ──┐
   ├─► Task 3 (provider status)  ───┤
   │                                ├─► Task 4 (expiry sweep) ──┐
   ├─► Task 5 (purge jobs)           │                          ├─► Task 7 (controls + docs)
   │                                 └─► Task 6 (reconciliation + admin API)
   └─────────────────────────────────────────────────────────────┘
```

Tasks 2, 3, and 5 may proceed in any order once 1 is done. Task 4 needs 2 and 3. Task 6 needs 3 and 4. Task 7 needs everything.

---

### Task 1: Schema, configuration, and the lease with fencing

**Objective:** Land the migration, every config variable, `@nestjs/schedule`, and a `MaintenanceLeaseService` **proven** to exclude a second holder — before any job depends on it.

**Dependencies:** none.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_phase5_expiry_and_reconciliation/migration.sql`
- Modify: `src/config/configuration.ts`, `src/config/env.validation.ts`, `.env.example`
- Create: `src/modules/maintenance/maintenance.module.ts`, `maintenance-lease.service.ts`, `maintenance-job-name.enum.ts`
- Modify: `src/app.module.ts`
- Modify: `test/helpers/truncate.ts`
- Create: `test/helpers/reset-leases.ts`
- Test: `src/modules/maintenance/maintenance-lease.service.spec.ts`, `test/maintenance-lease.e2e-spec.ts`

**Interfaces — Produces:**
```ts
export enum MaintenanceJobName {
  ORDER_EXPIRY = 'order-expiry',
  MAINTENANCE_PURGE = 'maintenance-purge',
  PAYMENT_RECONCILIATION = 'payment-reconciliation',
}

export class LeaseLostError extends Error {}

export class MaintenanceLeaseService {
  readonly instanceId: string;
  acquire(job: MaintenanceJobName): Promise<'acquired' | 'held' | 'missing'>;
  heartbeat(job: MaintenanceJobName): Promise<boolean>;
  release(job: MaintenanceJobName): Promise<void>;
  /** Throws LeaseLostError if this instance no longer holds the lease. */
  assertHeld(tx: Prisma.TransactionClient, job: MaintenanceJobName): Promise<void>;
}
```

- [ ] **Step 1: Add the enum and both models to the schema**

In `prisma/schema.prisma`, add `EXPIRED` to the existing enum and two models:

```prisma
enum OrderStatus {
  PENDING
  CANCELLED
  PAID
  EXPIRED
}

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

Add to `model Order`: `expiresAt DateTime? @map("expires_at")`, `expiredAt DateTime? @map("expired_at")`, `findings ReconciliationFinding[]`, and `@@index([status, expiresAt])`.

Add to `model RefreshToken`: `@@index([expiresAt])`. Add to `model PaymentEvent`: `@@index([createdAt])`.

- [ ] **Step 2: Generate the migration and add the enum-ordering guard plus the seed**

Run: `npx prisma migrate dev --name phase5_expiry_and_reconciliation --create-only`

Then edit the generated `migration.sql`. The `ALTER TYPE … ADD VALUE` must commit before anything references `'EXPIRED'` — nothing in this migration does, so no split is needed, but **append the lease seed** at the end:

```sql
INSERT INTO "maintenance_leases"
  ("job", "holder", "acquired_at", "heartbeat_at", "expires_at", "created_at", "updated_at")
VALUES
  ('order-expiry',           '', 'epoch', 'epoch', 'epoch', now(), now()),
  ('maintenance-purge',      '', 'epoch', 'epoch', 'epoch', now(), now()),
  ('payment-reconciliation', '', 'epoch', 'epoch', 'epoch', now(), now());
```

`expires_at = 'epoch'` makes every acquire an `UPDATE`, so no code path needs an insert race.

- [ ] **Step 3: Verify the migration from a FRESH database**

```bash
docker compose up -d postgres-test
npx prisma migrate reset --force --skip-seed --skip-generate
npx prisma migrate deploy
```

Then confirm the schema actually landed:

```bash
docker compose exec -T postgres-test psql -U postgres -d ecommerce_test -c \
  "SELECT unnest(enum_range(NULL::\"OrderStatus\"))::text ORDER BY 1;"
docker compose exec -T postgres-test psql -U postgres -d ecommerce_test -c \
  "SELECT job, expires_at FROM maintenance_leases ORDER BY job;"
docker compose exec -T postgres-test psql -U postgres -d ecommerce_test -c \
  "SELECT indexname FROM pg_indexes WHERE tablename IN ('orders','refresh_tokens','payment_events','reconciliation_findings') ORDER BY 1;"
```

Expected: `OrderStatus` contains `EXPIRED`; three lease rows at the epoch; indexes present including one on `orders (status, expires_at)`.

- [ ] **Step 4: Add configuration with Joi floors**

In `src/config/configuration.ts`, add to the `AppConfig` interface and the factory:

```ts
  maintenance: {
    jobsEnabled: boolean;
    orderExpiryCron: string;
    orderExpiryTtlMinutes: number;
    orderExpiryPaymentStartedTtlHours: number;
    orderExpiryBatchSize: number;
    purgeCron: string;
    purgeBatchSize: number;
    refreshTokenRetentionDays: number;
    paymentEventRetentionDays: number;
    reconcileCron: string;
    reconcileMinAgeMinutes: number;
    reconcileLookbackDays: number;
    reconcileBatchSize: number;
    reconcilePrecheckFailureThreshold: number;
    leaseSeconds: number;
  };
```

```ts
  maintenance: {
    jobsEnabled: process.env.MAINTENANCE_JOBS_ENABLED !== 'false',
    orderExpiryCron: process.env.ORDER_EXPIRY_CRON ?? '0 */5 * * * *',
    orderExpiryTtlMinutes: parseInt(process.env.ORDER_EXPIRY_TTL_MINUTES ?? '30', 10),
    orderExpiryPaymentStartedTtlHours: parseInt(
      process.env.ORDER_EXPIRY_PAYMENT_STARTED_TTL_HOURS ?? '24', 10),
    orderExpiryBatchSize: parseInt(process.env.ORDER_EXPIRY_BATCH_SIZE ?? '100', 10),
    purgeCron: process.env.MAINTENANCE_PURGE_CRON ?? '0 0 3 * * *',
    purgeBatchSize: parseInt(process.env.MAINTENANCE_PURGE_BATCH_SIZE ?? '1000', 10),
    refreshTokenRetentionDays: parseInt(process.env.REFRESH_TOKEN_RETENTION_DAYS ?? '30', 10),
    paymentEventRetentionDays: parseInt(process.env.PAYMENT_EVENT_RETENTION_DAYS ?? '90', 10),
    reconcileCron: process.env.RECONCILE_CRON ?? '0 */15 * * * *',
    reconcileMinAgeMinutes: parseInt(process.env.RECONCILE_MIN_AGE_MINUTES ?? '15', 10),
    reconcileLookbackDays: parseInt(process.env.RECONCILE_LOOKBACK_DAYS ?? '30', 10),
    reconcileBatchSize: parseInt(process.env.RECONCILE_BATCH_SIZE ?? '100', 10),
    reconcilePrecheckFailureThreshold: parseInt(
      process.env.RECONCILE_PRECHECK_FAILURE_THRESHOLD ?? '3', 10),
    leaseSeconds: parseInt(process.env.MAINTENANCE_LEASE_SECONDS ?? '300', 10),
  },
```

Also add `paymentProviderTimeoutMs` to the existing `payments` block:
```ts
    timeoutMs: parseInt(process.env.PAYMENT_PROVIDER_TIMEOUT_MS ?? '10000', 10),
```

In `src/config/env.validation.ts`, add — note the three floors, which are the point:

```ts
  MAINTENANCE_JOBS_ENABLED: Joi.boolean().default(true),
  ORDER_EXPIRY_CRON: Joi.string().default('0 */5 * * * *'),
  // Floor of 1: a TTL of 0 would stamp expiresAt = now() on every checkout and
  // expire orders the instant they are created.
  ORDER_EXPIRY_TTL_MINUTES: Joi.number().integer().min(1).default(30),
  ORDER_EXPIRY_PAYMENT_STARTED_TTL_HOURS: Joi.number().integer().min(1).default(24),
  ORDER_EXPIRY_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(100),
  MAINTENANCE_PURGE_CRON: Joi.string().default('0 0 3 * * *'),
  MAINTENANCE_PURGE_BATCH_SIZE: Joi.number().integer().min(1).max(10000).default(1000),
  // Floor of 7 == JWT_REFRESH_TTL. Below it the purge would delete LIVE tokens.
  REFRESH_TOKEN_RETENTION_DAYS: Joi.number().integer().min(7).default(30),
  // Floor of 30: payment_events is the webhook idempotency ledger; deleting a
  // row makes a pre-cutoff replay newly processable.
  PAYMENT_EVENT_RETENTION_DAYS: Joi.number().integer().min(30).default(90),
  RECONCILE_CRON: Joi.string().default('0 */15 * * * *'),
  // Floor of 6 minutes: must exceed WEBHOOK_TOLERANCE_SECONDS (300s), or an
  // in-flight payment is reported as divergent.
  RECONCILE_MIN_AGE_MINUTES: Joi.number().integer().min(6).default(15),
  RECONCILE_LOOKBACK_DAYS: Joi.number().integer().min(1).default(30),
  RECONCILE_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(100),
  RECONCILE_PRECHECK_FAILURE_THRESHOLD: Joi.number().integer().min(1).default(3),
  MAINTENANCE_LEASE_SECONDS: Joi.number().integer().min(30).default(300),
  PAYMENT_PROVIDER_TIMEOUT_MS: Joi.number().integer().min(1000).default(10000),
```

Add every variable to `.env.example` with its default and a one-line comment.

- [ ] **Step 5: Write the failing Joi floor test**

In `src/config/env.validation.spec.ts`:

```ts
it('rejects an order expiry TTL of 0, which would expire orders at creation', () => {
  const { error } = envValidationSchema.validate(
    { ...validEnv, ORDER_EXPIRY_TTL_MINUTES: '0' },
    { abortEarly: false },
  );

  expect(error?.message).toContain('ORDER_EXPIRY_TTL_MINUTES');
});

it('rejects a refresh-token retention below JWT_REFRESH_TTL, which would delete live tokens', () => {
  const { error } = envValidationSchema.validate(
    { ...validEnv, REFRESH_TOKEN_RETENTION_DAYS: '3' },
    { abortEarly: false },
  );

  expect(error?.message).toContain('REFRESH_TOKEN_RETENTION_DAYS');
});
```

Run: `npx jest src/config/env.validation.spec.ts -t 'expire orders at creation'`
Expected: FAIL — the key is unknown to the schema before Step 4's edit is in place, or passes validation without the floor.

- [ ] **Step 6: Install `@nestjs/schedule` and register it**

```bash
npm install @nestjs/schedule
```

In `src/app.module.ts`, add `ScheduleModule.forRoot()` to `imports` and `MaintenanceModule` after `PaymentsModule`. **Change nothing in the `providers` array** — guard order is registration-order dependent and must stay `ThrottlerGuard → JwtAuthGuard → RolesGuard`.

- [ ] **Step 7: Exclude `maintenance_leases` from `truncateAll()` and add `resetLeases()`**

This is Review Focus item 1. `truncateAll()` currently truncates every table except `_prisma_migrations`, which would wipe the seeded lease rows and make every acquire match zero.

In `test/helpers/truncate.ts`, change the query:

```ts
  const tables = await prisma.$queryRaw<TableRow[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
      -- maintenance_leases is seeded by migration and holds no test data.
      -- Truncating it would leave acquire() matching zero rows forever, so
      -- every job would report skipped:'lease-held' and no e2e job would run.
      AND tablename <> 'maintenance_leases'
    ORDER BY tablename
  `;
```

Create `test/helpers/reset-leases.ts`:

```ts
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Frees every maintenance lease. Call in beforeEach alongside truncateAll():
 * truncateAll() deliberately does not touch maintenance_leases, so a test that
 * leaves a lease held would otherwise block the next test's job.
 */
export async function resetLeases(prisma: PrismaService): Promise<void> {
  await prisma.maintenanceLease.updateMany({
    data: { holder: '', expiresAt: new Date(0) },
  });
}
```

- [ ] **Step 8: Write the failing lease unit tests**

In `src/modules/maintenance/maintenance-lease.service.spec.ts`:

```ts
describe('MaintenanceLeaseService', () => {
  let service: MaintenanceLeaseService;
  let prisma: { maintenanceLease: { updateMany: jest.Mock } };

  beforeEach(async () => {
    prisma = { maintenanceLease: { updateMany: jest.fn() } };
    const module = await Test.createTestingModule({
      providers: [
        MaintenanceLeaseService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => 300 } },
      ],
    }).compile();
    service = module.get(MaintenanceLeaseService);
  });

  it('reports acquired when the CAS matches one row', async () => {
    prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.acquire(MaintenanceJobName.ORDER_EXPIRY)).resolves.toBe(
      'acquired',
    );
  });

  it('reports held when the CAS matches nothing but the row exists', async () => {
    prisma.maintenanceLease.updateMany
      .mockResolvedValueOnce({ count: 0 }) // the acquire
      .mockResolvedValueOnce({ count: 1 }); // the existence probe

    await expect(service.acquire(MaintenanceJobName.ORDER_EXPIRY)).resolves.toBe(
      'held',
    );
  });

  it('reports missing when the row itself is absent', async () => {
    // Review Focus 3: a deleted lease row makes the job unrunnable forever,
    // and 'held' would hide that behind a routine warn.
    prisma.maintenanceLease.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.acquire(MaintenanceJobName.ORDER_EXPIRY)).resolves.toBe(
      'missing',
    );
  });

  it('heartbeat returns false when another instance has taken the lease', async () => {
    prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.heartbeat(MaintenanceJobName.ORDER_EXPIRY)).resolves.toBe(
      false,
    );
  });

  it('assertHeld throws LeaseLostError when the lease is gone', async () => {
    const tx = { maintenanceLease: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };

    await expect(
      service.assertHeld(tx as never, MaintenanceJobName.ORDER_EXPIRY),
    ).rejects.toThrow(LeaseLostError);
  });
});
```

Run: `npx jest src/modules/maintenance/maintenance-lease.service.spec.ts`
Expected: FAIL — `Cannot find module './maintenance-lease.service'`.

- [ ] **Step 9: Implement `MaintenanceLeaseService`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { MaintenanceJobName } from './maintenance-job-name.enum';

/** Thrown inside a transaction when this instance no longer holds the lease. */
export class LeaseLostError extends Error {
  constructor(job: string) {
    super(`Maintenance lease for ${job} is no longer held by this instance`);
    this.name = 'LeaseLostError';
  }
}

export type AcquireOutcome = 'acquired' | 'held' | 'missing';

/**
 * Mutual exclusion for maintenance jobs, as a row rather than a PostgreSQL
 * advisory lock (spec D6, §9.3.1). PrismaClient pools connections and offers no
 * pinning API, so a session-scoped pg_advisory_lock could unlock on a different
 * connection and leak; and pg_try_advisory_xact_lock cannot span a sweep that
 * makes provider calls outside transactions and commits one transaction per
 * order. A row needs no connection affinity at all.
 */
@Injectable()
export class MaintenanceLeaseService {
  private readonly logger = new Logger(MaintenanceLeaseService.name);
  readonly instanceId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private leaseMs(): number {
    return this.config.get<number>('maintenance.leaseSeconds', { infer: true }) * 1000;
  }

  /**
   * The project's CAS idiom: the predicate travels with the write, so two
   * instances racing produce one count===1 and one count===0.
   */
  async acquire(job: MaintenanceJobName): Promise<AcquireOutcome> {
    const now = new Date();
    const { count } = await this.prisma.maintenanceLease.updateMany({
      where: { job, expiresAt: { lte: now } },
      data: {
        holder: this.instanceId,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + this.leaseMs()),
      },
    });

    if (count === 1) {
      return 'acquired';
    }

    // Distinguish "someone holds it" from "the row is gone". The second is an
    // operational fault that would otherwise hide behind a routine warn and
    // leave the job silently unrunnable forever.
    const { count: exists } = await this.prisma.maintenanceLease.updateMany({
      where: { job },
      data: {},
    });

    return exists === 1 ? 'held' : 'missing';
  }

  /** Renews only this instance's own lease. */
  async heartbeat(job: MaintenanceJobName): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.maintenanceLease.updateMany({
      where: { job, holder: this.instanceId },
      data: { heartbeatAt: now, expiresAt: new Date(now.getTime() + this.leaseMs()) },
    });

    return count === 1;
  }

  /** Holder-scoped, so a late release cannot free another instance's lease. */
  async release(job: MaintenanceJobName): Promise<void> {
    await this.prisma.maintenanceLease.updateMany({
      where: { job, holder: this.instanceId },
      data: { holder: '', expiresAt: new Date(0) },
    });
  }

  /**
   * The fencing guarantee (spec §9.3.4). Called as the FIRST statement of every
   * mutating transaction, so the lease check and the mutation share one
   * transaction: an instance whose lease was taken over cannot commit.
   */
  async assertHeld(
    tx: Prisma.TransactionClient,
    job: MaintenanceJobName,
  ): Promise<void> {
    const { count } = await tx.maintenanceLease.updateMany({
      where: { job, holder: this.instanceId, expiresAt: { gt: new Date() } },
      data: { heartbeatAt: new Date() },
    });

    if (count === 0) {
      throw new LeaseLostError(job);
    }
  }
}
```

Run: `npx jest src/modules/maintenance/maintenance-lease.service.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Write the failing e2e exclusion test**

In `test/maintenance-lease.e2e-spec.ts` — this is the spec's §9.3.6 tests 1 and 2, and it must run against real PostgreSQL because the whole claim is about database-level exclusion:

```ts
describe('MaintenanceLease exclusion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    await truncateAll(prisma);
    await resetLeases(prisma);
  });

  /** Two instances == two services with different instanceIds, one database. */
  function newInstance(): MaintenanceLeaseService {
    return new MaintenanceLeaseService(prisma, app.get(ConfigService));
  }

  it('lets exactly one of two instances acquire the same lease', async () => {
    const a = newInstance();
    const b = newInstance();

    const [first, second] = await Promise.all([
      a.acquire(MaintenanceJobName.ORDER_EXPIRY),
      b.acquire(MaintenanceJobName.ORDER_EXPIRY),
    ]);

    expect([first, second].filter((r) => r === 'acquired')).toHaveLength(1);
    expect([first, second].filter((r) => r === 'held')).toHaveLength(1);
  });

  it('refuses a heartbeat after another instance takes the lease over', async () => {
    const a = newInstance();
    const b = newInstance();
    expect(await a.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');

    // Force A's lease to lapse, then let B take it.
    await prisma.maintenanceLease.update({
      where: { job: MaintenanceJobName.ORDER_EXPIRY },
      data: { expiresAt: new Date(0) },
    });
    expect(await b.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');

    expect(await a.heartbeat(MaintenanceJobName.ORDER_EXPIRY)).toBe(false);
  });

  it('rolls back a transaction whose lease was taken over (fencing)', async () => {
    const a = newInstance();
    const b = newInstance();
    expect(await a.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');
    await prisma.maintenanceLease.update({
      where: { job: MaintenanceJobName.ORDER_EXPIRY },
      data: { expiresAt: new Date(0) },
    });
    await b.acquire(MaintenanceJobName.ORDER_EXPIRY);

    const category = await createCategory(prisma);
    const product = await createProduct(prisma, { categoryId: category.id, stockQuantity: 5 });

    await expect(
      prisma.$transaction(async (tx) => {
        await a.assertHeld(tx, MaintenanceJobName.ORDER_EXPIRY);
        await tx.product.update({
          where: { id: product.id },
          data: { stockQuantity: 999 },
        });
      }),
    ).rejects.toThrow(LeaseLostError);

    // The guarantee that matters: nothing was committed.
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stockQuantity).toBe(5);
  });

  it('survives truncateAll, so e2e jobs are not silently skipped', async () => {
    // Review Focus 1. truncateAll() must not wipe the seeded lease rows.
    await truncateAll(prisma);

    const rows = await prisma.maintenanceLease.count();
    expect(rows).toBe(3);
    expect(await newInstance().acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');
  });
});
```

Run: `npx jest --config ./test/jest-e2e.json --runInBand test/maintenance-lease.e2e-spec.ts`
Expected: FAIL — the module does not exist yet, then passes once Steps 7 and 9 are in place.

- [ ] **Step 11: Create `MaintenanceModule` and run all gates**

```ts
@Module({
  providers: [MaintenanceLeaseService],
  exports: [MaintenanceLeaseService],
})
export class MaintenanceModule {}
```

Run, in order:
```bash
npm run lint:ci
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand
```
Expected: all green; unit > 325, e2e > 249.

- [ ] **Step 12: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/config .env.example \
  src/app.module.ts src/modules/maintenance test/helpers/truncate.ts \
  test/helpers/reset-leases.ts test/maintenance-lease.e2e-spec.ts package.json package-lock.json
git commit -m "feat(maintenance): add phase 5 schema, config, and the fenced lease"
```

**Acceptance criteria:**
1. `migrate deploy` on an empty database yields `EXPIRED` in `OrderStatus`, three epoch-dated lease rows, and the four new indexes — verified by the `psql` queries in Step 3.
2. Two `MaintenanceLeaseService` instances with different `instanceId`s racing `acquire()` produce exactly one `'acquired'` and one `'held'`.
3. `assertHeld()` inside a transaction throws `LeaseLostError` and **the transaction's other writes do not commit**.
4. `acquire()` returns `'missing'`, not `'held'`, when the row is absent.
5. `truncateAll()` leaves all three lease rows intact, and a job can acquire after it.
6. Joi rejects `ORDER_EXPIRY_TTL_MINUTES=0`, `REFRESH_TOKEN_RETENTION_DAYS=3`, and `PAYMENT_EVENT_RETENTION_DAYS=10`.
7. `@nestjs/schedule` is the only new dependency in `package.json`.
8. No `pg_advisory_lock` or `pg_try_advisory_xact_lock` anywhere in `src/`.

---

### Task 2: `EXPIRED` and the lifecycle decision

**Objective:** Make every consumer of `OrderStatus` decide what `EXPIRED` means. This task exists to satisfy the compile tripwire deliberately rather than inside a feature commit.

**Dependencies:** Task 1.

**Files:**
- Modify: `src/modules/orders/orders.service.ts` (`MarkPaidOutcome`, `markPaid`'s switch, `cancel`'s CAS-miss classifier)
- Modify: `src/modules/payments/payment-webhook.service.ts` (handle `'expired'`)
- Modify: `test/helpers/assert-stock-conserved.ts`
- Test: `src/modules/orders/orders.service.spec.ts`, `src/modules/payments/payment-webhook.service.spec.ts`, `test/orders.e2e-spec.ts`

**Interfaces — Produces:**
```ts
export type MarkPaidOutcome = 'paid' | 'already-paid' | 'cancelled' | 'expired' | 'not-found';
```

- [ ] **Step 1: Observe the tripwire firing**

Run: `npm run build`
Expected: FAIL in `orders.service.ts` — the `switch` over `OrderStatus` in `markPaid` is no longer exhaustive, so the function "lacks ending return statement". **This is the designed behaviour; do not add a `default` arm.**

- [ ] **Step 2: Write the failing unit tests**

In `src/modules/orders/orders.service.spec.ts`:

```ts
it('markPaid reports expired for an expired order, distinctly from cancelled', async () => {
  tx.order.updateMany.mockResolvedValue({ count: 0 });
  tx.order.findUnique.mockResolvedValue({ status: OrderStatus.EXPIRED });

  await expect(service.markPaid(tx, 'order-1')).resolves.toBe('expired');
});

it('cancel rejects an expired order with 409 and restores no stock', async () => {
  tx.order.updateMany.mockResolvedValue({ count: 0 });
  tx.order.findFirst.mockResolvedValue({
    id: 'order-1', status: OrderStatus.EXPIRED, items: [],
  });

  await expect(service.cancel('user-1', 'order-1')).rejects.toThrow(ConflictException);
  expect(productsService.incrementStock).not.toHaveBeenCalled();
});
```

In `src/modules/payments/payment-webhook.service.spec.ts`:

```ts
it('returns 200 and mutates nothing when the order already expired', async () => {
  ordersService.markPaid.mockResolvedValue('expired');

  await expect(service.apply(event)).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining('expired'),
  );
});
```

Run: `npx jest src/modules/orders/orders.service.spec.ts -t 'expired'`
Expected: FAIL — build error from Step 1, which these tests now justify fixing.

- [ ] **Step 3: Add the `EXPIRED` arm to `markPaid`**

In `src/modules/orders/orders.service.ts`, extend the type and add **one new arm** to the existing `switch` — no `default`:

```ts
/** The five ways markPaid can end. It never throws, so this is the whole API. */
export type MarkPaidOutcome =
  | 'paid'
  | 'already-paid'
  | 'cancelled'
  | 'expired'
  | 'not-found';
```

```ts
      case OrderStatus.CANCELLED:
        return 'cancelled';
      // Phase 5. Reported distinctly from 'cancelled' because the operator
      // response differs: a lapse is a system-initiated release, a cancel was a
      // customer action. The webhook's handling of the two is identical.
      case OrderStatus.EXPIRED:
        return 'expired';
```

- [ ] **Step 4: Add the `EXPIRED` branch to `cancel`**

Immediately after the existing `PAID` branch in the CAS-miss classifier:

```ts
        // Phase 5. Not idempotent-200 like already-CANCELLED: the system
        // released this order and its stock is already restored, so reporting
        // success would imply the caller's cancellation did something.
        if (existing.status === OrderStatus.EXPIRED) {
          throw new ConflictException('Order has expired');
        }
```

- [ ] **Step 5: Handle `'expired'` in the webhook**

In `src/modules/payments/payment-webhook.service.ts`, extend the outcome handling so `'expired'` takes the same log-loudly, change-nothing, return-200 path as `'cancelled'`, with its own message naming the lapse and the owed refund:

```ts
        case 'expired':
          this.logger.error(
            `Payment succeeded for order ${order.id} after it expired ` +
              `(event ${event.providerEventId}); stock was already restored and ` +
              `manual refund is required`,
          );
          break;
```

- [ ] **Step 6: Update `assertStockConserved`**

In `test/helpers/assert-stock-conserved.ts`, add `EXPIRED` to the set of statuses that hold stock — an expired order has had its stock returned, so it must **not** count as holding units:

```ts
    // PENDING and PAID hold their units; CANCELLED and EXPIRED have returned
    // them. Omitting EXPIRED here would make every expiry look like an
    // inventory leak.
    status: { in: [OrderStatus.PENDING, OrderStatus.PAID] },
```

(The existing predicate already excludes `CANCELLED`; confirm `EXPIRED` is likewise excluded and add a comment saying why, so the next status member is a deliberate decision here too.)

- [ ] **Step 7: Add the e2e assertion**

In `test/orders.e2e-spec.ts`:

```ts
it('refuses to cancel an expired order with 409', async () => {
  const order = await createOrder(prisma, { userId: user.id, status: OrderStatus.EXPIRED, lines: [...] });

  await request(app.getHttpServer())
    .post(`/api/v1/orders/${order.id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .expect(409);
});
```

- [ ] **Step 8: Run all gates**

```bash
npm run lint:ci && npm run build && npm test -- --runInBand && npm run test:e2e -- --runInBand
```
Expected: all green. The build error from Step 1 is gone because a real arm was added.

- [ ] **Step 9: Commit**

```bash
git add src/modules/orders src/modules/payments/payment-webhook.service.ts \
  test/helpers/assert-stock-conserved.ts test/orders.e2e-spec.ts
git commit -m "feat(orders): add EXPIRED terminal state and its lifecycle decisions"
```

**Acceptance criteria:**
1. `npm run build` fails before the new arm exists and passes after — **no `default` arm was added** to `markPaid`'s switch (verify by grep).
2. `markPaid` returns `'expired'`, distinct from `'cancelled'`.
3. `POST /orders/:id/cancel` on an `EXPIRED` order returns **409** and calls `incrementStock` zero times.
4. The webhook logs at `error` and returns **200** for an expired order; no row is mutated.
5. `assertStockConserved` treats `EXPIRED` as not holding stock, with a comment saying why.

---

### Task 3: Provider-contract extension

**Objective:** Give `retrievePayment()` a status, classify not-found separately from unreachable, and close the real gap that the Stripe client is constructed with no timeout.

**Dependencies:** Task 1.

**Files:**
- Modify: `src/modules/payments/provider/payment-provider.ts`
- Modify: `src/modules/payments/provider/fake-payment.provider.ts`
- Modify: `src/modules/payments/provider/stripe-payment.provider.ts`
- Test: both provider spec files

**Interfaces — Produces:**
```ts
export type ProviderPaymentStatus = 'succeeded' | 'pending';
export interface ProviderPayment { /* …existing… */ status: ProviderPaymentStatus; }
export class ProviderPaymentNotFoundError extends Error {}
```

- [ ] **Step 1: Write the failing fake-provider tests**

```ts
it('reports pending for a freshly created intent', async () => {
  const created = await provider.createPayment(input);

  expect(created.status).toBe('pending');
  await expect(provider.retrievePayment(created.providerPaymentId))
    .resolves.toMatchObject({ status: 'pending' });
});

it('reports succeeded once the test control marks it so', async () => {
  const created = await provider.createPayment(input);
  provider.markNextRetrieveSucceeded(created.providerPaymentId);

  await expect(provider.retrievePayment(created.providerPaymentId))
    .resolves.toMatchObject({ status: 'succeeded' });
});

it('rejects with ProviderPaymentNotFoundError for an unknown id', async () => {
  await expect(provider.retrievePayment('pi_never_minted'))
    .rejects.toThrow(ProviderPaymentNotFoundError);
});

it('rejects with a generic error when failNextRetrieve is armed', async () => {
  const created = await provider.createPayment(input);
  provider.failNextRetrieve();

  const error = await provider.retrievePayment(created.providerPaymentId).catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ProviderPaymentNotFoundError);
});
```

Run: `npx jest src/modules/payments/provider/fake-payment.provider.spec.ts -t 'status'`
Expected: FAIL — `status` is not on `ProviderPayment`.

- [ ] **Step 2: Extend the port**

In `payment-provider.ts`:

```ts
/**
 * Phase 5. Deliberately binary: Phase 5 only ever asks "may I release this
 * stock?", and requires-action / processing / canceled / failed all answer it
 * identically. Modelling the provider's full vocabulary would be inventing
 * provider behaviour to no benefit, and SUPPORTED_EVENT_TYPE is already only
 * 'payment_intent.succeeded'.
 */
export type ProviderPaymentStatus = 'succeeded' | 'pending';

/**
 * Not-found is an ERROR, not a third status (spec §7.3). Keeping it off
 * ProviderPaymentStatus preserves the binary meaning above and avoids a third
 * member every consumer would handle identically to 'pending'.
 */
export class ProviderPaymentNotFoundError extends Error {
  constructor(providerPaymentId: string) {
    super(`Provider does not recognise payment ${providerPaymentId}`);
    this.name = 'ProviderPaymentNotFoundError';
  }
}
```

Add `status: ProviderPaymentStatus;` to `ProviderPayment`. **The build will now fail at every construction site** — that is the intent.

- [ ] **Step 3: Implement in the fake**

Add `status: 'pending'` to both `createPayment`'s and `retrievePayment`'s returns, plus three controls following the existing `failNextCreate` idiom:

```ts
  private succeededIds = new Set<string>();
  private failRetrieve = false;

  /** The next retrievePayment rejects. A timeout is the same to the caller. */
  failNextRetrieve(): void { this.failRetrieve = true; }

  /** Marks an intent succeeded for subsequent retrievals. */
  markNextRetrieveSucceeded(providerPaymentId: string): void {
    this.succeededIds.add(providerPaymentId);
  }
```

`retrievePayment` throws `ProviderPaymentNotFoundError` for an id it never minted — which it already tracks, and which is why the P4 502 window exists. Add `succeededIds.clear()` and `failRetrieve = false` to `reset()`.

- [ ] **Step 4: Implement in the Stripe adapter, with the timeout**

```ts
    this.stripe = new Stripe(apiKey, {
      apiVersion: STRIPE_API_VERSION,
      // Phase 5. Previously absent, so a hung provider call could hang a
      // maintenance sweep indefinitely. 10s matches the project's own
      // TX_TIMEOUT_MS, its existing precedent for "longest a single operation
      // may take".
      timeout: config.get<number>('payments.timeoutMs', { infer: true }),
    });
```

Map the retrieved intent's status to `'succeeded'` only for the provider's documented success value and `'pending'` otherwise, and translate the SDK's resource-missing error to `ProviderPaymentNotFoundError`.

> **Implementer note:** the exact success value and the exact missing-resource error shape **must be read from Stripe's own documentation for the pinned API version `2026-08-26.dahlia`**, not inferred. If either cannot be verified, map conservatively to `'pending'` — the fail-closed direction — and record the gap in the task report. Do not guess.

- [ ] **Step 5: Run gates and commit**

```bash
npm run lint:ci && npm run build && npm test -- --runInBand && npm run test:e2e -- --runInBand
git add src/modules/payments/provider
git commit -m "feat(payments): expose provider payment status and pin a client timeout"
```

**Acceptance criteria:**
1. `ProviderPayment.status` exists; `createPayment` returns `'pending'`.
2. `retrievePayment` rejects with `ProviderPaymentNotFoundError` for an unminted id and with a plain `Error` when `failNextRetrieve()` is armed — the two are distinguishable by the caller.
3. The Stripe client is constructed with a `timeout` from config.
4. `ProviderPaymentStatus` has exactly two members.
5. No fifth method was added to the `PaymentProvider` interface (verify by grep: still four members).

---

### Task 4: Order expiry sweep

**Objective:** Expire eligible orders and restore their stock **exactly once and all-or-nothing**, with provider reads outside every transaction.

**Dependencies:** Tasks 2 and 3.

**Files:**
- Create: `src/modules/maintenance/order-expiry.service.ts`
- Create: `src/modules/maintenance/maintenance-runner.service.ts`, `maintenance.scheduler.ts`
- Modify: `src/modules/orders/orders.service.ts` (add `expire`), `orders.module.ts` (export), `checkout.service.ts` (stamp `expiresAt`)
- Modify: `src/modules/maintenance/maintenance.module.ts`
- Test: `order-expiry.service.spec.ts`, `test/order-expiry.e2e-spec.ts`

**Interfaces — Consumes:** `MaintenanceLeaseService.{acquire,heartbeat,release,assertHeld}`, `LeaseLostError`, `MaintenanceJobName` (Task 1); `MarkPaidOutcome` (Task 2); `ProviderPaymentNotFoundError`, `ProviderPayment.status` (Task 3); `ProductsService.incrementStock(tx, productId, quantity)` (Phase 3).

**Interfaces — Produces:**
```ts
export interface JobSummary {
  job: MaintenanceJobName; startedAt: Date; durationMs: number;
  status: 'completed' | 'skipped'; reason?: 'lease-held' | 'lease-missing' | 'disabled';
  examined: number; affected: number; skipped: number; failed: number;
}
export class MaintenanceRunnerService { run(job: MaintenanceJobName): Promise<JobSummary>; }
export class OrdersService { expire(orderId: string): Promise<'expired' | 'raced'>; }
```

- [ ] **Step 1: Stamp `expiresAt` at checkout**

In `src/modules/orders/checkout.service.ts`, inside the existing `tx.order.create`, add:

```ts
            expiresAt: new Date(
              Date.now() +
                this.config.get<number>('maintenance.orderExpiryTtlMinutes', {
                  infer: true,
                }) * 60_000,
            ),
```

Stored rather than computed so a later TTL change cannot retroactively expire history, and so tests can backdate it (spec §5.1).

- [ ] **Step 2: Write the failing `expire()` unit test**

```ts
it('expires the order and restores every line in one transaction', async () => {
  tx.order.updateMany.mockResolvedValue({ count: 1 });
  tx.orderItem.findMany.mockResolvedValue([
    { productId: 'p-a', quantity: 2 },
    { productId: 'p-b', quantity: 3 },
  ]);

  await expect(service.expire('order-1')).resolves.toBe('expired');

  expect(productsService.incrementStock).toHaveBeenCalledTimes(2);
  expect(productsService.incrementStock).toHaveBeenNthCalledWith(1, tx, 'p-a', 2);
  expect(productsService.incrementStock).toHaveBeenNthCalledWith(2, tx, 'p-b', 3);
});

it('restores nothing when the CAS loses the race', async () => {
  tx.order.updateMany.mockResolvedValue({ count: 0 });

  await expect(service.expire('order-1')).resolves.toBe('raced');
  expect(productsService.incrementStock).not.toHaveBeenCalled();
});
```

Run: `npx jest src/modules/orders/orders.service.spec.ts -t 'expires the order'`
Expected: FAIL — `service.expire is not a function`.

- [ ] **Step 3: Implement `OrdersService.expire()`**

```ts
  /**
   * The system-initiated terminal transition. Identical CAS shape to cancel(),
   * minus the userId predicate because no user owns this action.
   *
   * The CAS, the expiredAt stamp, the lease fencing, and EVERY incrementStock
   * share ONE transaction (spec §4.5). A partial restoration must be impossible:
   * an order whose transition committed with only some items restored would
   * silently destroy inventory, and nothing would re-select it because it is no
   * longer PENDING.
   */
  async expire(orderId: string): Promise<'expired' | 'raced'> {
    return this.prisma.$transaction(async (tx) => {
      await this.lease.assertHeld(tx, MaintenanceJobName.ORDER_EXPIRY);

      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.EXPIRED, expiredAt: new Date() },
      });

      if (count === 0) {
        return 'raced';
      }

      const items = await tx.orderItem.findMany({
        where: { orderId },
        orderBy: { productId: 'asc' },
      });

      for (const item of items) {
        await this.productsService.incrementStock(tx, item.productId, item.quantity);
      }

      return 'expired';
    });
  }
```

- [ ] **Step 4: Implement the runner**

```ts
  async run(job: MaintenanceJobName): Promise<JobSummary> {
    const startedAt = new Date();
    const outcome = await this.lease.acquire(job);

    if (outcome !== 'acquired') {
      // 'missing' is an operational fault, not routine contention, so it is
      // error-level: the job is silently unrunnable until the row is restored.
      const reason = outcome === 'held' ? 'lease-held' : 'lease-missing';
      if (outcome === 'missing') {
        this.logger.error(`No maintenance lease row for ${job}; job cannot run`);
      } else {
        this.logger.warn(`Lease for ${job} is held elsewhere; skipping tick`);
      }
      return { job, startedAt, durationMs: 0, status: 'skipped', reason,
               examined: 0, affected: 0, skipped: 0, failed: 0 };
    }

    const timer = setInterval(
      () => void this.lease.heartbeat(job),
      (this.config.get<number>('maintenance.leaseSeconds', { infer: true }) * 1000) / 3,
    );

    try {
      const counts = await this.jobs[job]();
      return { job, startedAt, durationMs: Date.now() - startedAt.getTime(),
               status: 'completed', ...counts };
    } finally {
      clearInterval(timer);
      await this.lease.release(job);
    }
  }
```

The job map is a typed `Record`, so a missing entry is a compile error and no string ever selects a method:

```ts
  private readonly jobs: Record<MaintenanceJobName, () => Promise<JobCounts>> = {
    [MaintenanceJobName.ORDER_EXPIRY]: () => this.expiry.sweep(),
    [MaintenanceJobName.MAINTENANCE_PURGE]: () => this.purge.run(),
    [MaintenanceJobName.PAYMENT_RECONCILIATION]: () => this.reconciler.run(),
  };
```

> Tasks 5 and 6 supply `purge.run()` and `reconciler.run()`. Until then, register them as services returning `{ examined: 0, affected: 0, skipped: 0, failed: 0 }` so this task compiles and its own job works; Tasks 5 and 6 replace the bodies, not the wiring.

- [ ] **Step 5: Implement the two-phase sweep**

`OrderExpiryService.sweep()`:

**Phase 1 — no transaction.** Select the batch with the spec's §5.4 predicate. For each candidate: skip tier B inside its 24-hour gate; for tier B call `provider.retrievePayment()` and branch — `succeeded` → record intent to file `PROVIDER_SUCCESS_LOCAL_NOT_PAID` and skip; `ProviderPaymentNotFoundError` → skip; any other rejection → skip and count the failure. Tier A proceeds with no provider call, because there is no `providerPaymentId` to look up.

**Phase 2 — one transaction per vetted order**, via `ordersService.expire()`. A `LeaseLostError` aborts the whole sweep; any other per-order error increments `failed` and continues.

```ts
    for (const order of vetted) {
      try {
        const result = await this.orders.expire(order.id);
        result === 'expired' ? affected++ : skipped++;
      } catch (error) {
        if (error instanceof LeaseLostError) throw error; // stop immediately
        this.logger.error(`Failed to expire order ${order.id}`, error as Error);
        failed++;
      }
    }
```

- [ ] **Step 6: Write the failing e2e tests**

```ts
it('expires a tier-A order past its deadline and restores exactly its units', async () => {
  const product = await createProduct(prisma, { categoryId: category.id, stockQuantity: 10 });
  const order = await createOrder(prisma, {
    userId: user.id, lines: [{ productId: product.id, quantity: 3 }],
  });
  await prisma.product.update({ where: { id: product.id }, data: { stockQuantity: 7 } });
  await prisma.order.update({
    where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  const summary = await runner.run(MaintenanceJobName.ORDER_EXPIRY);

  expect(summary.affected).toBe(1);
  const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(after.status).toBe(OrderStatus.EXPIRED);
  expect(after.expiredAt).not.toBeNull();
  expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stockQuantity).toBe(10);
  await assertStockConserved(prisma, product.id, 10);
});

it('expires an order whose deadline is exactly now (inclusive boundary)', async () => {
  // Review Focus 2: `<=` vs `<` decides whether the deadline itself expires.
  const order = await createOrder(prisma, { userId: user.id, lines: [{ productId: product.id, quantity: 1 }] });
  await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date() } });

  expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).affected).toBe(1);
});

it('restores every line of a multi-item order together', async () => {
  // Review Focus 5, positive half. The negative half is control C-E3 in Task 7.
  // ...two products, quantities 2 and 5, both restored in full
});

it('never selects a PAID order', async () => { /* status PAID, past deadline → affected 0 */ });

it('never selects an order with a null expiresAt', async () => { /* affected 0 */ });

it('does not expire a tier-B order inside its 24-hour gate', async () => { /* affected 0, skipped 1 */ });

it('does not expire a tier-B order the provider reports succeeded', async () => {
  provider.markNextRetrieveSucceeded(payment.providerPaymentId);

  expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).affected).toBe(0);
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status)
    .toBe(OrderStatus.PENDING);
});

it('does not expire a tier-B order when the provider read fails (fail closed)', async () => {
  provider.failNextRetrieve();

  expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).affected).toBe(0);
});

it('does not expire a tier-B order whose intent the provider does not recognise', async () => {
  await prisma.payment.update({
    where: { id: payment.id }, data: { providerPaymentId: 'pi_never_minted' },
  });

  expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).affected).toBe(0);
});

it('aborts the sweep without committing when the lease is lost mid-run', async () => {
  // Spec §9.3.6 test 3, at sweep level.
});
```

- [ ] **Step 7: Add the scheduler delegates**

Three one-line `@Cron` methods reading their expressions from `ConfigService`, each guarded by `maintenance.jobsEnabled`, each calling `runner.run(...)` and nothing else. No logic here — tests call `runner.run()` directly, so no timer is ever advanced in a test.

- [ ] **Step 8: Run gates and commit**

```bash
npm run lint:ci && npm run build && npm test -- --runInBand && npm run test:e2e -- --runInBand
git add src/modules/maintenance src/modules/orders test/order-expiry.e2e-spec.ts
git commit -m "feat(maintenance): add the order expiry sweep with atomic stock release"
```

**Acceptance criteria:**
1. A tier-A order past its deadline becomes `EXPIRED` with `expiredAt` set, and **exactly** its units return; `assertStockConserved` passes.
2. A multi-item order restores **all** lines in one transaction.
3. An order whose `expiresAt` equals the query instant **is** expired.
4. `PAID` orders and `expiresAt IS NULL` orders are never selected.
5. A tier-B order is not expired when inside its gate, when the provider reports `succeeded`, when the read fails, or when the id is unrecognised — **four separate tests**.
6. `expire()` with a losing CAS returns `'raced'` and calls `incrementStock` zero times.
7. No provider call occurs inside a transaction — `$transaction` callbacks contain no `provider.` reference (verify by reading `order-expiry.service.ts` and `orders.service.ts:expire`).
8. A lost lease aborts the sweep and commits nothing.

---

### Task 5: Purge jobs

**Objective:** Bound the two unbounded tables, with cutoffs that cannot delete live or still-needed rows.

**Dependencies:** Task 1.

**Files:**
- Create: `src/modules/maintenance/maintenance-purge.service.ts`
- Modify: `src/modules/maintenance/maintenance.module.ts`
- Test: `maintenance-purge.service.spec.ts`, `test/maintenance-purge.e2e-spec.ts`

**Interfaces — Produces:** `MaintenancePurgeService.run(): Promise<JobCounts>`

- [ ] **Step 1: Write the failing e2e tests**

```ts
it('deletes refresh tokens whose expiry is past the cutoff', async () => {
  const stale = await createRefreshToken(prisma, {
    userId: user.id, expiresAt: new Date(Date.now() - 31 * 86_400_000),
  });
  const recent = await createRefreshToken(prisma, {
    userId: user.id, expiresAt: new Date(Date.now() - 1 * 86_400_000),
  });

  await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

  expect(await prisma.refreshToken.findUnique({ where: { id: stale.id } })).toBeNull();
  expect(await prisma.refreshToken.findUnique({ where: { id: recent.id } })).not.toBeNull();
});

it('never deletes a live refresh token', async () => {
  // The cutoff is on expiry, not creation, so a valid token is never eligible
  // however old it is.
  const live = await createRefreshToken(prisma, {
    userId: user.id, expiresAt: new Date(Date.now() + 86_400_000),
  });

  await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

  expect(await prisma.refreshToken.findUnique({ where: { id: live.id } })).not.toBeNull();
});

it('deletes payment events past the retention cutoff only', async () => { /* 91d vs 1d */ });

it('is idempotent — a second run deletes nothing more', async () => {
  const first = await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);
  const second = await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

  expect(first.affected).toBeGreaterThan(0);
  expect(second.affected).toBe(0);
});
```

- [ ] **Step 2: Implement the purge**

Two `deleteMany` calls, each cutoff-predicated and batch-bounded, each wrapped so one table's failure does not abort the other:

```ts
  /**
   * The refresh-token cutoff is on expiresAt, NOT createdAt: a long-lived valid
   * token must never be deleted. Revoked-but-unexpired rows are retained until
   * their own expiry passes the cutoff, because they are reuse-detection
   * evidence — Phase 1 revokes a whole family on replay, and deleting the row
   * early turns a detectable replay into an unknown token.
   */
```

For `payment_events` the cutoff is `createdAt`, with the comment that this table is the webhook idempotency ledger, so a deleted row makes a pre-cutoff replay newly processable.

- [ ] **Step 3: Run gates and commit**

```bash
npm run lint:ci && npm run build && npm test -- --runInBand && npm run test:e2e -- --runInBand
git add src/modules/maintenance test/maintenance-purge.e2e-spec.ts
git commit -m "feat(maintenance): purge expired refresh tokens and old payment events"
```

**Acceptance criteria:**
1. Rows past each cutoff are deleted; rows inside it are not.
2. A **live** (unexpired) refresh token is never deleted, regardless of age.
3. A second consecutive run deletes nothing (idempotent by predicate).
4. A failure purging one table does not prevent the other from running.
5. Both deletes are bounded by `MAINTENANCE_PURGE_BATCH_SIZE`.

---

### Task 6: Reconciliation and the admin API

**Objective:** Detect and report divergence — never remediate — and expose it on two ADMIN-only routes with closed-set dispatch.

**Dependencies:** Tasks 3 and 4.

**Files:**
- Create: `payment-reconciliation.service.ts`, `reconciliation-finding.writer.ts`, `admin-maintenance.controller.ts`, and the four DTOs
- Modify: `maintenance.module.ts`, `src/modules/orders/dto/order-response.dto.ts`
- Test: `payment-reconciliation.service.spec.ts`, `reconciliation-finding.writer.spec.ts`, `test/payment-reconciliation.e2e-spec.ts`, `test/admin-maintenance.e2e-spec.ts`, `test/swagger.e2e-spec.ts`

**Interfaces — Produces:**
```ts
export type ReconciliationFindingKind =
  | 'PROVIDER_SUCCESS_LOCAL_NOT_PAID' | 'PAID_ORDER_TERMINAL_UNPAYABLE'
  | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH'
  | 'PROVIDER_PAYMENT_NOT_FOUND' | 'PROVIDER_UNREACHABLE';
```

- [ ] **Step 1: Write the failing finding-lifecycle tests**

The three transitions of spec §8.5, which are the non-obvious part:

```ts
it('creates a finding on first observation', async () => { /* occurrences 1, resolvedAt null */ });

it('increments occurrences and advances lastSeenAt on re-observation', async () => {
  await writer.record(order.id, payment.id, 'AMOUNT_MISMATCH', detail);
  await writer.record(order.id, payment.id, 'AMOUNT_MISMATCH', detail);

  const rows = await prisma.reconciliationFinding.findMany({ where: { orderId: order.id } });
  expect(rows).toHaveLength(1);              // ONE row, not two
  expect(rows[0].occurrences).toBe(2);
});

it('resolves a finding whose condition cleared', async () => {
  await writer.record(order.id, payment.id, 'AMOUNT_MISMATCH', detail);
  await writer.resolve(order.id, 'AMOUNT_MISMATCH');

  expect((await one()).resolvedAt).not.toBeNull();
});

it('re-opens the SAME row on recurrence, preserving occurrences and firstSeenAt', async () => {
  await writer.record(order.id, payment.id, 'AMOUNT_MISMATCH', detail);
  const first = await one();
  await writer.resolve(order.id, 'AMOUNT_MISMATCH');
  await writer.record(order.id, payment.id, 'AMOUNT_MISMATCH', detail);

  const again = await one();
  expect(again.id).toBe(first.id);
  expect(again.resolvedAt).toBeNull();
  expect(again.occurrences).toBe(2);                    // continues, not reset
  expect(again.firstSeenAt).toEqual(first.firstSeenAt);  // never rewritten
});
```

- [ ] **Step 2: Implement the writer as an `upsert`**

```ts
  /** upsert, not create: two concurrent passes must not raise a unique violation. */
  async record(orderId: string, paymentId: string | null,
               kind: ReconciliationFindingKind, detail: Prisma.InputJsonValue): Promise<void> {
    const now = new Date();
    await this.prisma.reconciliationFinding.upsert({
      where: { orderId_kind: { orderId, kind } },
      create: { orderId, paymentId, kind, detail, occurrences: 1,
                firstSeenAt: now, lastSeenAt: now },
      // occurrences is NOT reset and firstSeenAt is NOT rewritten: the operator
      // wants "this has happened 11 times since <date>", not "once since the
      // last clear". resolvedAt is cleared because a divergence seen again is
      // no longer resolved.
      update: { occurrences: { increment: 1 }, lastSeenAt: now,
                resolvedAt: null, detail, paymentId },
    });
  }
```

- [ ] **Step 3: Implement the three candidate sets and six kinds**

Per spec §8.2 and §8.3. Candidate set 3 (open findings, re-evaluated) is the one that makes resolution possible at all — without it a finding on a payment that became `SUCCEEDED` leaves set 1 and stays open forever. Control C-R2 in Task 7 proves it.

`detail` carries **ids, amounts, currencies, and timestamps only** — never a provider payload, never a `clientSecret`.

- [ ] **Step 4: Implement the admin controller**

```ts
@ApiTags('admin-maintenance')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminMaintenanceController {
  @Post('maintenance/:job/run')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Run a maintenance job synchronously' })
  @ApiResponse({ status: 200, description: 'Completed, or skipped because the lease was held' })
  @ApiResponse({ status: 400, description: 'Unknown job name' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an administrator' })
  @ApiResponse({ status: 409, description: 'The job is already running' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async run(@Param() params: RunJobParamsDto): Promise<JobSummaryResponseDto> {
    const summary = await this.runner.run(params.job);

    if (summary.status === 'skipped' && summary.reason === 'lease-held') {
      throw new ConflictException('Maintenance job is already running');
    }

    return JobSummaryResponseDto.from(summary);
  }
}
```

`RunJobParamsDto` is `@IsEnum(MaintenanceJobName)`, so an unlisted name is a 400 from the global pipe and never reaches dispatch. The `@Throttle` key **must** be `default`.

- [ ] **Step 5: Add `expiresAt` to the order DTO**

In `OrderResponseDto`, add `expiresAt: Date | null` and map it in `from()` — matching how `cancelledAt` is already exposed as a raw `Date`.

- [ ] **Step 6: Write the failing admin e2e tests**

```ts
it('returns 401 for an anonymous caller', /* … */);
it('returns 403 for an authenticated customer', /* … */);
it('returns 400 for an unlisted job name', async () => {
  await request(app.getHttpServer())
    .post('/api/v1/admin/maintenance/drop-everything/run')
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(400);
});
it('returns 409 while the lease is held', async () => {
  const other = new MaintenanceLeaseService(prisma, app.get(ConfigService));
  await other.acquire(MaintenanceJobName.ORDER_EXPIRY);

  await request(app.getHttpServer())
    .post('/api/v1/admin/maintenance/order-expiry/run')
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(409);
});
it('returns a summary with no identifiers or provider data', async () => {
  const { body } = await request(/* … */).expect(200);

  expect(Object.keys(body).sort()).toEqual(
    ['affected','durationMs','examined','failed','job','skipped','startedAt','status'].sort(),
  );
  expect(JSON.stringify(body)).not.toMatch(/clientSecret|pi_|cus_/);
});
it('defaults the findings list to active findings only', async () => { /* resolved excluded */ });
```

- [ ] **Step 7: Extend the Swagger route inventory**

In `test/swagger.e2e-spec.ts`, raise the expected path and operation counts and add the two new routes to the per-route assertions (`tags` contains `admin-maintenance`, non-empty `summary`, exact response-code set). The existing exact-set assertions will fail until updated — that is the inventory check working.

- [ ] **Step 8: Run gates and commit**

```bash
npm run lint:ci && npm run build && npm test -- --runInBand && npm run test:e2e -- --runInBand
git add src/modules/maintenance src/modules/orders/dto test/payment-reconciliation.e2e-spec.ts \
  test/admin-maintenance.e2e-spec.ts test/swagger.e2e-spec.ts
git commit -m "feat(maintenance): add payment reconciliation reporting and the admin API"
```

**Acceptance criteria:**
1. All six finding kinds are produced in tests using **only** `retrievePayment()` — no provider-listing capability was added.
2. One row per `(orderId, kind)` however many passes observe it; `occurrences` and `lastSeenAt` advance; `firstSeenAt` never changes.
3. A cleared condition sets `resolvedAt`; a recurrence re-opens the **same row** with `occurrences` continuing.
4. Reconciliation mutates no `orders`, `payments`, or `products` row — the service contains no `.update`/`.create`/`.delete` against those models (verify by grep).
5. The admin route returns 401 / 403 / 400 / 409 / 429 as specified, and the summary body contains exactly the eight documented keys.
6. Dispatch is a typed `Record`; `grep -n 'this\[' src/modules/maintenance/` returns nothing.
7. `GET /orders/:id` exposes `expiresAt`.
8. Both new routes appear in the OpenAPI document with `@ApiTags`, `@ApiOperation`, and `@ApiResponse`, and the route-inventory assertion covers them.

---

### Task 7: Negative controls, concurrency suite, and documentation

**Objective:** Prove every concurrency claim by recording its control failing first, then make the documentation match the shipped roadmap.

**Dependencies:** all previous tasks.

**Files:**
- Create: `test/maintenance-concurrency.e2e-spec.ts`
- Modify: `README.md`, `CLAUDE.md`, `docs/deferred-limitations.md`

- [ ] **Step 1: Write the concurrency suite**

Phase 4's harness pattern is mandatory: `await app.listen(0)` in setup so `Promise.all` issues real parallel HTTP, `createTestApp([], { throttleLimit: 0 })`, tokens minted via `app.get(TokenService).signAccessToken(user)`, and **every test asserts no response is a 5xx**.

```ts
it('expiry racing cancel restores stock exactly once', async () => {
  const [cancelled, summary] = await Promise.all([
    request(app.getHttpServer()).post(`/api/v1/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${token}`),
    runner.run(MaintenanceJobName.ORDER_EXPIRY),
  ]);

  expect([200, 409]).toContain(cancelled.status);
  const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
  expect(after.stockQuantity).toBe(initialStock);        // restored ONCE
  await assertStockConserved(prisma, product.id, initialStock);
});

it('expiry racing the webhook yields exactly one terminal state', /* … */);

it('two instances both sweeping restore stock exactly once', async () => {
  const a = new MaintenanceRunnerService(/* instance A */);
  const b = new MaintenanceRunnerService(/* instance B */);

  const [ra, rb] = await Promise.all([
    a.run(MaintenanceJobName.ORDER_EXPIRY),
    b.run(MaintenanceJobName.ORDER_EXPIRY),
  ]);

  expect([ra, rb].filter((r) => r.status === 'completed')).toHaveLength(1);
  expect([ra, rb].filter((r) => r.reason === 'lease-held')).toHaveLength(1);
  expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stockQuantity)
    .toBe(initialStock);
});

it('N concurrent admin triggers produce one run and no 5xx', /* 20 parallel, expect 1×200 + 19×409 */);
```

- [ ] **Step 2: Run each negative control and RECORD its failing output**

**A green concurrency run is never evidence** (spec §14.4). For each control: apply the naive implementation, run the suite, **copy the actual failure output into the task report**, restore from a byte copy, and confirm `git diff` is empty.

Each control must fail **on the assertion that names the property** — not by crashing, not with a `TypeError`, not on a `P2025`. A control that fails for the wrong reason proves nothing and must be re-shaped until it fails correctly.

| Control | Change | Must fail with |
|---|---|---|
| C-E1 | `expire()` as read → check `status` → update | stock restored **twice** |
| C-E2 | remove the `acquire` **and** the `assertHeld` fencing | two instances both restore |
| C-E3 | move the `incrementStock` loop outside the transition's transaction, with an induced mid-loop throw | a **partial** restoration persists |
| C-E4 | move the provider pre-check inside the transaction | external I/O inside a transaction |
| C-E5 | fail-open on provider error | a succeeded payment's order expired, stock restored |
| C-P1 | purge without the cutoff predicate | live rows deleted |
| C-R1 | finding `create` instead of `upsert` | duplicate rows for one `(orderId, kind)` |
| C-R2 | drop candidate set 3 | a finding stays unresolved after its condition clears |

If a control does not reproduce its failure, record a **null result** and report the property as unproven — as Phase 3 did for C3 and Phase 4 for its sequential P1 control. Never upgrade a green run to proof by assertion.

- [ ] **Step 3: Run the suite three times for stability**

```bash
for i in 1 2 3; do npx jest --config ./test/jest-e2e.json --runInBand test/maintenance-concurrency.e2e-spec.ts; done
```
Expected: identical pass counts, no re-runs to green. Record all three.

- [ ] **Step 4: Update the documentation**

**`README.md`:** mark Phase 5 ✅ with its scope; move the current phase to Phase 6; **remove "Redis caching & BullMQ background jobs" as Phase 5's description** and say Redis/BullMQ await a workload needing a broker, naming transactional email and refunds; document the new env vars and the admin routes.

**`CLAUDE.md`:** add a Phase 5 section in the established voice covering the fenced lease and why advisory locks were rejected, the two-tier TTL, fail-closed, expiry atomicity, the veto-not-authority rule, and reconciliation being detection-only. **Amend line 17** so it no longer claims Redis-backed throttler storage waits for Phase 5.

**`docs/deferred-limitations.md`:**
- **Close by shipping** (never by deleting): PENDING stock holding, `refresh_tokens` purge, `payment_events` purge, and the detection half of reconciliation — the entry stays open for remediation.
- **Amend** the refund-after-cancel entry to name `EXPIRED` alongside `CANCELLED`.
- **Add two new entries:** `reconciliation_findings` has no purge; and provider-side orphan discovery requires a fifth port capability nothing justifies today.

- [ ] **Step 5: Run all gates and commit**

```bash
npm run lint:ci && npm run build && npm test -- --runInBand && npm run test:e2e -- --runInBand
git add test/maintenance-concurrency.e2e-spec.ts README.md CLAUDE.md docs/deferred-limitations.md
git commit -m "test(maintenance): prove phase 5 concurrency invariants and update docs"
```

**Acceptance criteria:**
1. **Every control in Step 2 is recorded failing on its own assertion**, or explicitly recorded as a null result.
2. Expiry vs cancel, expiry vs webhook, and two-instance sweeps each restore stock exactly once, with no 5xx anywhere.
3. 20 concurrent admin triggers produce exactly one `200` and nineteen `409`s.
4. The suite passes three consecutive times with identical counts.
5. `README.md` and `CLAUDE.md` no longer describe Redis/BullMQ as Phase 5.
6. The four closed entries are closed **by shipping**; no entry was deleted; two new entries added.
7. Final gates green with unit > 325 and e2e > 249.

---

## Self-Review

**1. Spec coverage.** Every numbered spec section maps to a task: §4 (lifecycle) → Task 2 · §4.5 (atomicity) → Task 4 · §5 (expiry, TTLs, races) → Tasks 1, 4 · §6 (payments after P4) → Tasks 2, 3, 4 · §7 (port) → Task 3 · §8 (reconciliation, finding schema, lifecycle, orphan deferral) → Tasks 1, 6, 7 · §9 (scheduling, lease, fencing, failure) → Tasks 1, 4 · §10 (admin API) → Task 6 · §11 (`expiresAt`) → Task 6 · §12 (security) → Tasks 1, 6 · §13 (observability) → Tasks 4, 6 · §14 (testing, controls) → every task, consolidated in 7 · §15 (migration, config, purge) → Tasks 1, 5 · §16.1 (locked decisions) → Global Constraints · §18 (30 DoD items) → distributed across the seven acceptance-criteria blocks. **No gaps found.**

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Two places name work without inlining full code — Task 4 Step 5's phase description and Task 6 Step 3's candidate sets — and both cite the exact spec section that specifies them, with the surrounding code shown. The one deliberate instruction-to-verify is Task 3 Step 4's Stripe status mapping, which the spec requires to come from provider documentation rather than from this plan.

**3. Type consistency.** `MaintenanceJobName`, `LeaseLostError`, `AcquireOutcome`, `JobSummary`, `JobCounts`, `MarkPaidOutcome`, `ProviderPaymentStatus`, `ProviderPaymentNotFoundError`, and `ReconciliationFindingKind` are each defined once and referenced consistently. `expire()` returns `'expired' | 'raced'` everywhere. `incrementStock(tx, productId, quantity)` matches Phase 3's existing signature. **Corrected during review:** the spec's §11 says `expiresAt` is an ISO string; the codebase exposes `cancelledAt` as a raw `Date`, so the plan uses `Date | null` and says why.

**4. Review Focus.** All five items have an owning task and a named test: lease survival across `truncateAll()` (Task 1 Step 10), the inclusive deadline boundary (Task 4 Step 6), `'missing'` vs `'held'` (Task 1 Steps 8–9), the TTL-of-zero Joi floor (Task 1 Step 5), and multi-item all-or-nothing restoration (Task 4 Step 6 positive, Task 7 C-E3 negative).

**5. Rejected mechanisms.** No task introduces Redis, BullMQ, a queue, caching, an advisory lock, a refund, reconciliation remediation, a confirm-payment route, a provider-listing method, or a second writer of `PAID`. Task 1's acceptance criteria and Task 6's include explicit greps for the first and last of these.
