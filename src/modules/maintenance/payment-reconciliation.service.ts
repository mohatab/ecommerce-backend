import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  ProviderPaymentNotFoundError,
} from '../payments/provider/payment-provider';
// `import type` is required for a type used in a decorated constructor
// signature under isolatedModules + emitDecoratorMetadata (TS1272).
import type { PaymentProvider } from '../payments/provider/payment-provider';
import { JobCounts } from './job-counts';
import {
  ReconciliationFindingKind,
  ReconciliationFindingWriter,
} from './reconciliation-finding.writer';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const TERMINAL_UNPAYABLE = [OrderStatus.CANCELLED, OrderStatus.EXPIRED];

/** One candidate: a local payment row plus the order it belongs to. */
interface Candidate {
  paymentId: string;
  providerPaymentId: string;
  paymentStatus: PaymentStatus;
  orderId: string;
  orderStatus: OrderStatus;
  orderTotalCents: number;
  orderCurrency: string;
}

/**
 * What one candidate's evaluation concluded.
 *
 * TWO sets, not one, and the second is the fail-closed half.
 *
 *   detected   — kinds whose condition holds right now.
 *   determined — kinds this pass actually decided, either way.
 *
 * A kind that is determined and not detected is resolved. A kind that is
 * neither is left exactly as it was. The distinction exists because a
 * provider read that FAILED decides nothing: resolving `AMOUNT_MISMATCH`
 * because the provider was unreachable would turn an outage into an all-clear
 * on the money path. Provider uncertainty never becomes a state change —
 * not to an order, and not to a finding either.
 */
interface Evaluation {
  detected: Map<ReconciliationFindingKind, Prisma.InputJsonValue>;
  determined: Set<ReconciliationFindingKind>;
  /**
   * What the provider read did, reported explicitly rather than inferred from
   * which kinds ended up determined. The first draft inferred it and counted
   * a not-found as a failure, which is wrong for the same reason the expiry
   * sweep counts not-found as skipped: nothing malfunctioned.
   */
  read: 'none' | 'ok' | 'not-found' | 'failed';
}

/**
 * Payment reconciliation: DETECTION AND REPORTING ONLY (D5, spec §8).
 *
 * It never writes `orders`, `payments`, or `products`. The
 * signature-verified webhook remains the sole writer of `OrderStatus.PAID`;
 * a provider read here is evidence for an operator, never an authority over
 * local state (D3). The only rows this job writes are
 * `reconciliation_findings`, through `ReconciliationFindingWriter`.
 *
 * Three candidate sets, all local-first (§8.2), which is what makes
 * `ReconciliationFinding.orderId` always available (D7). Set 3 — every open
 * finding, re-evaluated — is not an optimisation: without it a finding whose
 * payment later became SUCCEEDED leaves set 1 and stays open forever, and
 * nothing in the system could ever clear it.
 *
 * No transaction is opened anywhere below, so no provider call can be inside
 * one and the runner's heartbeat never queues behind a lease-row lock.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  /**
   * providerPaymentId -> consecutive failed reads, for the
   * `RECONCILE_PRECHECK_FAILURE_THRESHOLD` gate on `PROVIDER_UNREACHABLE`
   * (§8.3). Per-process and in memory on purpose: the threshold exists so a
   * single transient blip does not raise a finding, and the only durable store
   * available is the findings table itself — writing there to count would
   * raise the finding the threshold is meant to delay. A restart resets the
   * count, which costs at most `threshold` extra ticks before an outage
   * surfaces; it cannot cause a false finding.
   *
   * Bounded by pruning to the ids seen in the current tick, so it can never
   * grow past one batch.
   */
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly findings: ReconciliationFindingWriter,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async run(): Promise<JobCounts> {
    const batchSize = this.config.get('maintenance.reconcileBatchSize', {
      infer: true,
    });

    const open = await this.findings.open(batchSize);
    const candidates = await this.selectCandidates(batchSize, open);

    // kind -> orderIds with that kind still open, for transition three.
    const openByOrder = new Map<string, ReconciliationFindingKind[]>();

    for (const finding of open) {
      const kinds = openByOrder.get(finding.orderId) ?? [];

      kinds.push(finding.kind as ReconciliationFindingKind);
      openByOrder.set(finding.orderId, kinds);
    }

    const counts: JobCounts = {
      examined: candidates.length,
      affected: 0,
      skipped: 0,
      // `failed` counts CANDIDATES — one per order whose evaluation could not
      // be completed — matching the expiry sweep's unit rather than the
      // purge's per-table one. Reconciliation is per-order work, so an order
      // is the only unit an operator can act on.
      failed: 0,
    };

    let providerReads = 0;
    let notFound = 0;

    for (const candidate of candidates) {
      const evaluation = await this.evaluate(candidate);

      if (evaluation.read !== 'none') {
        providerReads += 1;
      }

      if (evaluation.read === 'not-found') {
        notFound += 1;
      }

      if (evaluation.read === 'failed') {
        // Counted whether or not the threshold was reached: the candidate's
        // evaluation is incomplete either way, and it is re-examined next
        // tick against a fresh read.
        counts.failed += 1;
      }

      let changed = 0;

      for (const [kind, detail] of evaluation.detected) {
        await this.findings.record(
          candidate.orderId,
          candidate.paymentId,
          kind,
          detail,
        );
        changed += 1;
      }

      for (const kind of openByOrder.get(candidate.orderId) ?? []) {
        if (
          evaluation.determined.has(kind) &&
          !evaluation.detected.has(kind) &&
          (await this.findings.resolve(candidate.orderId, kind))
        ) {
          changed += 1;
        }
      }

      if (changed === 0) {
        counts.skipped += 1;
      } else {
        counts.affected += changed;
      }
    }

    this.warnIfProviderLooksMisconfigured(providerReads, notFound);
    this.pruneFailureCounters(candidates);

    return counts;
  }

  /**
   * The three candidate sets of spec §8.2, unioned by payment id.
   *
   * Set 3 contributes the ORDERS of open findings, so a divergence that has
   * since cleared is re-examined and resolved even though its payment no
   * longer appears in set 1 or set 2.
   */
  private async selectCandidates(
    batchSize: number,
    open: { orderId: string }[],
  ): Promise<Candidate[]> {
    const now = Date.now();
    const select = {
      id: true,
      providerPaymentId: true,
      status: true,
      orderId: true,
      order: { select: { status: true, totalCents: true, currency: true } },
    } as const;

    const [unresolved, refundOwed, forOpenFindings] = await Promise.all([
      // Set 1: unresolved payments, old enough that an in-flight payment is
      // not mistaken for a divergence, young enough to bound the set.
      this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.PENDING,
          createdAt: {
            lte: new Date(
              now -
                this.config.get('maintenance.reconcileMinAgeMinutes', {
                  infer: true,
                }) *
                  MINUTE_MS,
            ),
            gte: new Date(
              now -
                this.config.get('maintenance.reconcileLookbackDays', {
                  infer: true,
                }) *
                  DAY_MS,
            ),
          },
        },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
        select,
      }),
      // Set 2: refund owed. Needs no provider call at all — it is a
      // disagreement between two local tables.
      this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.SUCCEEDED,
          order: { status: { in: TERMINAL_UNPAYABLE } },
        },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
        select,
      }),
      // Set 3's payments, by the orders its findings name.
      this.prisma.payment.findMany({
        where: { orderId: { in: open.map((finding) => finding.orderId) } },
        // Bounded like the other two sets, so §8.2's "bounded per tick" is
        // true of the UNION and not merely of each half. Without it the tick
        // was bounded only indirectly, by open findings times payments per
        // order. `orderBy` because a `take` without one is arbitrary.
        orderBy: { createdAt: 'asc' },
        take: batchSize,
        select,
      }),
    ]);

    const byPaymentId = new Map<string, Candidate>();

    for (const row of [...unresolved, ...refundOwed, ...forOpenFindings]) {
      byPaymentId.set(row.id, {
        paymentId: row.id,
        providerPaymentId: row.providerPaymentId,
        paymentStatus: row.status,
        orderId: row.orderId,
        orderStatus: row.order.status,
        orderTotalCents: row.order.totalCents,
        orderCurrency: row.order.currency,
      });
    }

    return [...byPaymentId.values()];
  }

  /**
   * One candidate against the six kinds of spec §8.3.
   *
   * A SUCCEEDED local payment needs NO provider call: every kind that is still
   * decidable for it is decidable from two local tables, and the one that is
   * not — a provider amount or currency disagreement — is left undetermined
   * rather than guessed. This is also what makes resolution work: a payment
   * that has become SUCCEEDED locally FALSIFIES
   * `PROVIDER_SUCCESS_LOCAL_NOT_PAID` without asking anyone, so the open
   * finding from when it was PENDING resolves on this pass.
   */
  private async evaluate(candidate: Candidate): Promise<Evaluation> {
    const observedAt = new Date().toISOString();
    const detected = new Map<
      ReconciliationFindingKind,
      Prisma.InputJsonValue
    >();
    const determined = new Set<ReconciliationFindingKind>();

    // Purely local, so always determined.
    determined.add('PAID_ORDER_TERMINAL_UNPAYABLE');

    if (
      candidate.paymentStatus === PaymentStatus.SUCCEEDED &&
      (TERMINAL_UNPAYABLE as OrderStatus[]).includes(candidate.orderStatus)
    ) {
      detected.set('PAID_ORDER_TERMINAL_UNPAYABLE', {
        providerPaymentId: candidate.providerPaymentId,
        orderStatus: candidate.orderStatus,
        orderTotalCents: candidate.orderTotalCents,
        orderCurrency: candidate.orderCurrency,
        observedAt,
      });
    }

    if (candidate.paymentStatus !== PaymentStatus.PENDING) {
      // Locally falsified: the local side is no longer "not paid".
      determined.add('PROVIDER_SUCCESS_LOCAL_NOT_PAID');

      return { detected, determined, read: 'none' };
    }

    // From here on a provider read is attempted. PROVIDER_UNREACHABLE is
    // deliberately NOT marked determined yet: only a read that ANSWERS proves
    // reachability, and the answer arrives in the two arms below.
    //
    // Marking it here was a real bug, and it was the fail-closed rule applied
    // to raising a finding but not to clearing one. A failed read below
    // threshold detects nothing, so a determined-and-not-detected
    // PROVIDER_UNREACHABLE was RESOLVED by the very read that proves the
    // provider is still unreachable — which happens after a restart or when
    // pruneFailureCounters() drops the id. The alertable number of spec §13,
    // COUNT(*) WHERE resolved_at IS NULL, then went all-clear mid-outage for
    // up to `threshold` ticks. A failed read is the evidence the finding
    // should STAY OPEN.

    try {
      const providerPayment = await this.provider.retrievePayment(
        candidate.providerPaymentId,
      );

      this.consecutiveFailures.delete(candidate.providerPaymentId);
      // The provider answered, so it is reachable: this is the only thing
      // that may clear an open PROVIDER_UNREACHABLE.
      determined.add('PROVIDER_UNREACHABLE');
      determined.add('PROVIDER_SUCCESS_LOCAL_NOT_PAID');
      determined.add('PROVIDER_PAYMENT_NOT_FOUND');
      determined.add('AMOUNT_MISMATCH');
      determined.add('CURRENCY_MISMATCH');

      if (providerPayment.status === 'succeeded') {
        // D3: reported, NOT acted on. The order is not marked PAID here or
        // anywhere outside the signature-verified webhook.
        detected.set('PROVIDER_SUCCESS_LOCAL_NOT_PAID', {
          providerPaymentId: candidate.providerPaymentId,
          providerAmountMinorUnits: providerPayment.amountMinorUnits,
          providerCurrency: providerPayment.currency,
          orderTotalCents: candidate.orderTotalCents,
          orderCurrency: candidate.orderCurrency,
          observedAt,
        });
      }

      if (providerPayment.amountMinorUnits !== candidate.orderTotalCents) {
        detected.set('AMOUNT_MISMATCH', {
          providerPaymentId: candidate.providerPaymentId,
          providerAmountMinorUnits: providerPayment.amountMinorUnits,
          orderTotalCents: candidate.orderTotalCents,
          observedAt,
        });
      }

      // Both sides are uppercase by contract — the adapter normalises inbound
      // (C8) and the domain never stores lowercase — so this comparison is
      // exact on purpose. Making it case-insensitive here would paper over an
      // adapter that stopped normalising.
      if (providerPayment.currency !== candidate.orderCurrency) {
        detected.set('CURRENCY_MISMATCH', {
          providerPaymentId: candidate.providerPaymentId,
          providerCurrency: providerPayment.currency,
          orderCurrency: candidate.orderCurrency,
          observedAt,
        });
      }

      return { detected, determined, read: 'ok' };
    } catch (error) {
      if (error instanceof ProviderPaymentNotFoundError) {
        // A definite answer, so the counter clears: the provider WAS reached,
        // which also clears an open PROVIDER_UNREACHABLE.
        this.consecutiveFailures.delete(candidate.providerPaymentId);
        determined.add('PROVIDER_UNREACHABLE');
        determined.add('PROVIDER_PAYMENT_NOT_FOUND');
        detected.set('PROVIDER_PAYMENT_NOT_FOUND', {
          providerPaymentId: candidate.providerPaymentId,
          observedAt,
        });

        // Amount and currency stay UNDETERMINED: an id the provider cannot
        // find has no amount to compare against.
        return { detected, determined, read: 'not-found' };
      }

      // Network, timeout, 5xx, rate limit — all one fact to us (D4), and the
      // error itself is never logged or stored, because a provider error
      // string can carry payload fragments.
      const failures =
        (this.consecutiveFailures.get(candidate.providerPaymentId) ?? 0) + 1;

      this.consecutiveFailures.set(candidate.providerPaymentId, failures);

      const threshold = this.config.get(
        'maintenance.reconcilePrecheckFailureThreshold',
        { infer: true },
      );

      if (failures >= threshold) {
        detected.set('PROVIDER_UNREACHABLE', {
          providerPaymentId: candidate.providerPaymentId,
          consecutiveFailures: failures,
          observedAt,
        });
      } else {
        this.logger.warn(
          `Provider read for payment ${candidate.providerPaymentId} failed ` +
            `(${failures}/${threshold} consecutive); no finding raised yet`,
        );
      }

      return { detected, determined, read: 'failed' };
    }
  }

  /**
   * ONE log line for a whole-tick not-found sweep, instead of treating N
   * identical not-founds as N independent divergences.
   *
   * Stripe answers `resource_missing` for an id that belongs to another
   * account or to the other key mode, exactly as it does for an id that never
   * existed — the two are indistinguishable at the API, so the adapter cannot
   * separate them. What IS distinguishable is the SHAPE: one payment the
   * provider lost is a divergence; every payment in the batch at once is a
   * credential or account misconfiguration. The per-order findings are still
   * recorded — they are real, and each names an order an operator can check —
   * but this line is what tells them where to look first.
   *
   * The threshold is reused rather than given its own knob: it already means
   * "how many of this before it is a signal rather than a blip", and a second
   * number with the same job is a second number to tune wrongly.
   */
  private warnIfProviderLooksMisconfigured(
    providerReads: number,
    notFound: number,
  ): void {
    const threshold = this.config.get(
      'maintenance.reconcilePrecheckFailureThreshold',
      { infer: true },
    );

    if (notFound >= threshold && notFound === providerReads) {
      this.logger.error(
        `All ${notFound} provider reads this tick returned not-found. ` +
          'That is the shape of a payment-provider account or key-mode ' +
          'mismatch, not of that many independent divergences; check ' +
          'PAYMENT_PROVIDER and the API key before triaging the findings.',
      );
    }
  }

  /** Keeps the failure map bounded by one batch, never by table age. */
  private pruneFailureCounters(candidates: Candidate[]): void {
    const seen = new Set(
      candidates.map((candidate) => candidate.providerPaymentId),
    );

    for (const providerPaymentId of this.consecutiveFailures.keys()) {
      if (!seen.has(providerPaymentId)) {
        this.consecutiveFailures.delete(providerPaymentId);
      }
    }
  }
}
