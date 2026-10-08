import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import {
  PAYMENT_PROVIDER,
  ProviderPaymentNotFoundError,
} from '../payments/provider/payment-provider';
// `import type` is required for a type used in a decorated constructor
// signature under isolatedModules + emitDecoratorMetadata (TS1272).
import type { PaymentProvider } from '../payments/provider/payment-provider';
import { JobCounts } from './job-counts';
import { LeaseLostError } from './maintenance-lease.service';
import { ReconciliationFindingWriter } from './reconciliation-finding.writer';

const HOUR_MS = 3_600_000;

/**
 * The expiry sweep. It closes the project's longest-standing deferred
 * limitation: a PENDING order holding inventory forever.
 *
 * TWO PHASES, and the split is the whole design (spec §5.5):
 *
 *   Phase 1 — read and vet. No transaction, no row lock. This is where the
 *             provider is asked about tier-B candidates, because Phase 4's
 *             absolute rule is that no provider call may ever happen inside a
 *             transaction. Nothing here writes.
 *   Phase 2 — commit, one transaction per vetted order, via
 *             OrdersService.expire(). The CAS in there is the authority.
 *
 * Phase 1's provider read is deliberately STALE by the time Phase 2 commits,
 * and that is safe: if the webhook marked the order PAID in between, Phase 2's
 * `status: PENDING` predicate matches nothing and the expiry simply does not
 * happen.
 *
 * FAIL CLOSED, everywhere. An order is left PENDING when the provider says
 * `succeeded`, when it does not recognise the payment, and when the call fails
 * for any other reason. Unknown state is never grounds to release stock.
 */
@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly orders: OrdersService,
    private readonly findings: ReconciliationFindingWriter,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async sweep(): Promise<JobCounts> {
    const now = new Date();
    const paymentStartedTtlMs =
      this.config.get('maintenance.orderExpiryPaymentStartedTtlHours', {
        infer: true,
      }) * HOUR_MS;

    const candidates = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        // `lte`, not `lt`: an order whose deadline is exactly this instant is
        // past due. `not: null` is redundant in SQL — NULL <= now is unknown —
        // and stated anyway because the exclusion of never-expiring orders is
        // a rule (spec §5.4), not a side effect of three-valued logic.
        expiresAt: { not: null, lte: now },
        OR: [
          // Tier A: payment was never initiated.
          { payment: { is: null } },
          // Tier B: initiated and unresolved. A SUCCEEDED payment cannot
          // appear here anyway — its order is PAID — but naming PENDING keeps
          // the predicate true to §5.4 rather than relying on that.
          { payment: { is: { status: PaymentStatus.PENDING } } },
        ],
      },
      orderBy: { expiresAt: 'asc' },
      take: this.config.get('maintenance.orderExpiryBatchSize', {
        infer: true,
      }),
      select: {
        id: true,
        payment: {
          // `id` is selected for ReconciliationFinding.paymentId below.
          select: { id: true, providerPaymentId: true, createdAt: true },
        },
      },
    });

    const counts: JobCounts = {
      examined: candidates.length,
      affected: 0,
      skipped: 0,
      failed: 0,
    };

    // ---- Phase 1: vet. No transaction is open anywhere below. ----
    const vetted: string[] = [];

    for (const candidate of candidates) {
      const payment = candidate.payment;

      if (payment === null) {
        // Tier A. No providerPaymentId exists, so no pre-check is possible —
        // that asymmetry is the reason the two tiers exist (spec §5.2). Do
        // not invent a lookup here.
        vetted.push(candidate.id);
        continue;
      }

      // Tier B's longer clock runs from the payment row, not the order row,
      // so it is applied here rather than folded into expiresAt (spec §5.4).
      if (now.getTime() < payment.createdAt.getTime() + paymentStartedTtlMs) {
        counts.skipped += 1;
        continue;
      }

      // The try wraps ONLY the provider call. The finding write below used to
      // sit inside it, which would have reported a Prisma failure with the
      // catch's "could not read payment status from the provider" message —
      // the wrong diagnosis for the wrong subsystem.
      let providerPayment;

      try {
        providerPayment = await this.provider.retrievePayment(
          payment.providerPaymentId,
        );
      } catch (error) {
        if (error instanceof ProviderPaymentNotFoundError) {
          // "The provider does not have this payment" is evidence, but it is
          // evidence of a divergence, not of abandonment — so it still fails
          // closed. Counted as skipped, not failed: nothing malfunctioned.
          this.logger.error(
            `Order ${candidate.id}: provider does not recognise payment ` +
              `${payment.providerPaymentId}; not expiring`,
          );
          counts.skipped += 1;
          continue;
        }

        // Unavailable, timeout, 5xx, rate limit — all the same to us (D4).
        // Counted as failed because something did malfunction, and the order
        // is re-examined on the next tick against fresh state.
        this.logger.error(
          `Order ${candidate.id}: could not read payment status from the ` +
            `provider; not expiring`,
          error instanceof Error ? error.stack : undefined,
        );
        counts.failed += 1;
        continue;
      }

      if (providerPayment.status === 'succeeded') {
        // D3: the read is a VETO, never an authority. The order is left
        // PENDING and is NOT marked PAID — only the signature-verified
        // webhook writes PAID.
        //
        // The finding is recorded HERE, at veto time (spec §5.5 step 2),
        // rather than left to reconciliation to re-derive: an operator asking
        // "why did this order not expire?" should find a row, and this is the
        // only place that holds the answer at the moment the decision is made.
        // Reconciliation's candidate set 1 detects the same condition, and the
        // writer's upsert on (orderId, kind) is exactly why two producers are
        // safe — the second observation advances the counters of the first
        // row instead of colliding.
        await this.findings.record(
          candidate.id,
          payment.id,
          'PROVIDER_SUCCESS_LOCAL_NOT_PAID',
          {
            providerPaymentId: payment.providerPaymentId,
            providerAmountMinorUnits: providerPayment.amountMinorUnits,
            providerCurrency: providerPayment.currency,
            observedAt: new Date().toISOString(),
          },
        );
        this.logger.error(
          `Order ${candidate.id}: provider reports payment ` +
            `${payment.providerPaymentId} succeeded while the order is ` +
            `still PENDING; not expiring`,
        );
        counts.skipped += 1;
        continue;
      }

      vetted.push(candidate.id);
    }

    // ---- Phase 2: commit, one transaction per order (spec §4.5). ----
    for (const orderId of vetted) {
      try {
        const result = await this.orders.expire(orderId);

        if (result === 'expired') {
          counts.affected += 1;
        } else {
          counts.skipped += 1;
        }
      } catch (error) {
        // A lost lease means another instance owns this job now. Continuing
        // would be work we are no longer entitled to do, and every remaining
        // order would fail the same fencing check anyway.
        if (error instanceof LeaseLostError) {
          throw error;
        }

        this.logger.error(
          `Failed to expire order ${orderId}`,
          error instanceof Error ? error.stack : undefined,
        );
        counts.failed += 1;
      }
    }

    return counts;
  }
}
