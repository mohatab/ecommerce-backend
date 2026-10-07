import { Logger } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService, MarkPaidOutcome } from '../orders/orders.service';
import { PaymentWebhookService } from './payment-webhook.service';
import {
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

describe('PaymentWebhookService.apply', () => {
  let service: PaymentWebhookService;
  let tx: {
    paymentEvent: {
      createMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
    order: { findUnique: jest.Mock<Promise<unknown>, [unknown]> };
    payment: {
      createMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
      updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
  };
  let prisma: {
    $transaction: jest.Mock<Promise<unknown>, [unknown, unknown?]>;
  };
  let orders: {
    markPaid: jest.Mock<Promise<MarkPaidOutcome>, [unknown, string]>;
  };

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
      // A PASS-THROUGH implementation, never a bare jest.fn(): a bare mock
      // returns undefined, the callback never runs, and every assertion below
      // would pass vacuously while proving nothing.
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
        data: {
          orderId: string;
          providerPaymentId: string;
          status: PaymentStatus;
        };
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

    it.each<MarkPaidOutcome>([
      'paid',
      'already-paid',
      'cancelled',
      'expired',
      'not-found',
    ])('never throws on outcome %s', async (outcome) => {
      orders.markPaid.mockResolvedValue(outcome);

      await expect(service.apply(EVENT)).resolves.toBeUndefined();
    });

    /**
     * Phase 5. The failure this pins is a SILENT one: before the switch
     * existed, 'expired' fell past `if (outcome === 'cancelled')` and
     * produced no log at all, so a payment landing on a system-released
     * order was invisible. Asserting the error log is the only observable
     * difference — nothing is mutated on this path by design.
     *
     * tx.order exposes only findUnique, so any mutation attempt would throw
     * "is not a function"; markPaid is mocked and never reaches the row.
     */
    it('logs at error level and mutates nothing when the order expired', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      orders.markPaid.mockResolvedValue('expired');

      try {
        await expect(service.apply(EVENT)).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const message = String(errorSpy.mock.calls[0][0]);
        // Names the lapse, not a cancellation: the operator response differs.
        expect(message).toContain('expired');
        expect(message).toContain('order-1');
        expect(message).toContain('evt_1');
        expect(message).not.toContain('CANCELLED');
      } finally {
        errorSpy.mockRestore();
      }
    });

    // The distinction, asserted directly: folding 'expired' into the
    // 'cancelled' arm would make these two messages identical.
    it('uses a different message for expired than for cancelled', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        orders.markPaid.mockResolvedValue('cancelled');
        await service.apply(EVENT);
        orders.markPaid.mockResolvedValue('expired');
        await service.apply(EVENT);

        expect(String(errorSpy.mock.calls[0][0])).not.toBe(
          String(errorSpy.mock.calls[1][0]),
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    // The success paths must stay silent at error level. An over-eager
    // switch that logged on every outcome would make the error log useless.
    it.each<MarkPaidOutcome>(['paid', 'already-paid'])(
      'logs no error on the success outcome %s',
      async (outcome) => {
        const errorSpy = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        orders.markPaid.mockResolvedValue(outcome);

        try {
          await service.apply(EVENT);

          expect(errorSpy).not.toHaveBeenCalled();
        } finally {
          errorSpy.mockRestore();
        }
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

    /**
     * The no-provider-I/O guarantee for THIS service is architectural, not
     * behavioural: it injects no provider, so no provider call is reachable
     * from inside its transaction at all. There is nothing to relocate and
     * therefore nothing a runtime assertion could catch — PaymentsService's
     * own structural test (spec §15.1) covers the initiation path.
     *
     * What CAN be pinned is the absence itself. design:paramtypes is emitted
     * by `emitDecoratorMetadata` for the @Injectable() constructor, so adding
     * a third dependency — a provider, an HTTP client, anything capable of
     * I/O — changes this array and fails here.
     */
    it('injects only PrismaService and OrdersService, so no provider is reachable', () => {
      expect(
        Reflect.getMetadata('design:paramtypes', PaymentWebhookService),
      ).toEqual([PrismaService, OrdersService]);
    });
  });
});
