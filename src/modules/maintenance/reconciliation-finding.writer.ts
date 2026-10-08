import { Injectable } from '@nestjs/common';
import { Prisma, ReconciliationFinding } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The six kinds, as an object rather than a bare union, so one declaration
 * serves both purposes: `keyof typeof` gives the exact union the services use,
 * and the object itself is what `@IsEnum()` validates the query filter
 * against. A second list would be a second thing to forget to update.
 *
 * Phase 5 adds no seventh kind. A provider-side orphan — a payment at the
 * provider with no local row — is NOT detectable here and is deferred
 * (spec §8.6): it needs a `listPayments` port capability that nothing in this
 * repository has a caller for.
 */
export const RECONCILIATION_FINDING_KINDS = {
  PROVIDER_SUCCESS_LOCAL_NOT_PAID: 'PROVIDER_SUCCESS_LOCAL_NOT_PAID',
  PAID_ORDER_TERMINAL_UNPAYABLE: 'PAID_ORDER_TERMINAL_UNPAYABLE',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  PROVIDER_PAYMENT_NOT_FOUND: 'PROVIDER_PAYMENT_NOT_FOUND',
  PROVIDER_UNREACHABLE: 'PROVIDER_UNREACHABLE',
} as const;

export type ReconciliationFindingKind =
  keyof typeof RECONCILIATION_FINDING_KINDS;

export interface FindingListFilter {
  kind?: ReconciliationFindingKind;
  resolved: boolean;
  skip: number;
  take: number;
}

/**
 * The one owner of `reconciliation_findings`, the way `ProductsService` is the
 * one owner of `products`. It is named for its interesting half — the three
 * lifecycle transitions of spec §8.5 — and also carries the operator read,
 * because splitting one table across two services buys nothing.
 *
 * Nothing here is ever deleted, and nothing here touches `orders`,
 * `payments`, or `products`. Reconciliation reports; it never remediates (D5).
 *
 * No transaction is opened, deliberately. Every write below is a single
 * statement that PostgreSQL makes atomic on its own, so the job holds no row
 * lock across a provider call and never blocks the runner's lease heartbeat
 * behind `assertHeld`. The lease still prevents duplicate work; correctness
 * here does not depend on it, because a finding is advisory and the upsert is
 * idempotent under concurrency.
 */
@Injectable()
export class ReconciliationFindingWriter {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Transitions one and two of spec §8.5, as a single `upsert` keyed on
   * `(orderId, kind)`.
   *
   * `upsert`, never `create`: two passes observing the same divergence — two
   * instances, or a cron tick overlapping an admin trigger — would otherwise
   * race to an unhandled unique violation, and Prisma errors are never caught
   * in a service.
   *
   * `occurrences` is NOT reset and `firstSeenAt` is NOT rewritten on the
   * update path. The operator wants "this has happened eleven times since
   * <date>", not "once since the last clear", so a recurrence re-opens this
   * same row and continues its counters. `resolvedAt` IS cleared: a divergence
   * observed again is not resolved. `detail` is replaced with the current
   * observation, because the latest numbers are the actionable ones.
   */
  async record(
    orderId: string,
    paymentId: string | null,
    kind: ReconciliationFindingKind,
    detail: Prisma.InputJsonValue,
  ): Promise<void> {
    const now = new Date();

    await this.prisma.reconciliationFinding.upsert({
      where: { orderId_kind: { orderId, kind } },
      create: {
        orderId,
        paymentId,
        kind,
        detail,
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        occurrences: { increment: 1 },
        lastSeenAt: now,
        resolvedAt: null,
        detail,
        paymentId,
      },
    });
  }

  /**
   * Transition three: the condition no longer holds. Counters are left alone —
   * a resolved finding is history, not a reset.
   *
   * `updateMany` with `resolvedAt: null` in the predicate, so this is a CAS
   * like every other claim in this project: re-resolving an already-resolved
   * row matches nothing and reports `false`, which keeps the job's `affected`
   * count honest about rows it actually changed. It also cannot create a row,
   * which `upsert` could.
   */
  async resolve(
    orderId: string,
    kind: ReconciliationFindingKind,
  ): Promise<boolean> {
    const { count } = await this.prisma.reconciliationFinding.updateMany({
      where: { orderId, kind, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });

    return count > 0;
  }

  /** Every open finding, oldest first — candidate set 3 of spec §8.2. */
  open(take: number): Promise<ReconciliationFinding[]> {
    return this.prisma.reconciliationFinding.findMany({
      where: { resolvedAt: null },
      orderBy: { firstSeenAt: 'asc' },
      take,
    });
  }

  /**
   * The operator read behind `GET /admin/reconciliation/findings`.
   *
   * `resolvedAt IS NULL` IS the definition of active (§8.5), so the filter is
   * a null check rather than a stored boolean that could disagree with it.
   * The ordering carries `id` as a tiebreaker: `lastSeenAt` alone is not
   * unique, and a non-deterministic order makes page 2 able to repeat or skip
   * a row from page 1.
   */
  async list(
    filter: FindingListFilter,
  ): Promise<{ items: ReconciliationFinding[]; total: number }> {
    const where: Prisma.ReconciliationFindingWhereInput = {
      resolvedAt: filter.resolved ? { not: null } : null,
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
    };

    const [items, total] = await Promise.all([
      this.prisma.reconciliationFinding.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
        skip: filter.skip,
        take: filter.take,
      }),
      this.prisma.reconciliationFinding.count({ where }),
    ]);

    return { items, total };
  }
}
