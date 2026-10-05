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
import { PAYMENT_PROVIDER } from './provider/payment-provider';
// Type-only, and it must stay that way. `isolatedModules` plus the
// `emitDecoratorMetadata` Nest requires makes TS1272 an error for an
// INTERFACE used as the type of a decorated constructor parameter: the
// emitted design:paramtypes would reference a binding that erases to
// nothing. PAYMENT_PROVIDER above is a real value (the Symbol token), so it
// stays an ordinary import; PaymentProvider and ProviderPayment are
// interfaces and must not be.
import type {
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

      // clientSecret is never among the persisted columns (S4): it is
      // returned and then forgotten.
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
        return {
          payment,
          clientSecret: created.clientSecret,
          created: count === 1,
        };
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
