import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { ProviderEvent } from './provider/payment-provider';

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  /**
   * TWO dependencies, and that list is load-bearing. No PAYMENT_PROVIDER is
   * injected here and none may ever be: the "no provider I/O inside the
   * transaction" rule is then architectural rather than a convention anyone
   * has to remember, because no provider call is reachable from this file at
   * all. Pinned by the design:paramtypes assertion in the spec file.
   */
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
          // NOT refund it (docs/deferred-limitations.md, spec §17.1). Recorded
          // loudly and acknowledged, so the provider stops retrying.
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
   * fired (§11.5). The conditional update carries its own predicate instead,
   * and it is a CAS on status: PENDING so a duplicate cannot rewrite
   * succeededAt.
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
      // Deliberately NOT phrased as "a row under a different intent", which
      // is the §8.3 orphan case. Both statements also no-op for a SECOND
      // authentic event against an order whose row is already SUCCEEDED, and
      // nothing read here distinguishes the two — the same reason §11.5 gives
      // for never trusting `count` on this table. The log states what is
      // known; naming one cause would be a false diagnosis in the other.
      this.logger.warn(
        `Order ${event.orderId} already had a payment row that neither the ` +
          `insert nor the conditional update touched for intent ` +
          `${event.providerPaymentId} (a different intent, or already ` +
          `SUCCEEDED); recording the order as paid anyway`,
      );
    }
  }
}
