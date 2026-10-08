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
  // Phase 5. Initiation neither reads nor asserts this — PaymentsService
  // branches on the local Payment row, never on a provider status — but the
  // port now requires it, and a fixture that lied about the shape would be
  // the one place a missing field could hide.
  status: 'pending',
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
        findFirst: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue(ORDER),
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
      // The default implementation RUNS the callback with this same mock as
      // its `tx`. A bare jest.fn() here resolves undefined, so a control that
      // wrapped the provider call in a transaction would crash on the
      // undefined result before reaching the `not.toHaveBeenCalled()`
      // assertion below — the control would fail, but not for the reason the
      // test exists to state. Verified: with this pass-through, control 1
      // fails on that assertion itself.
      $transaction: jest
        .fn<Promise<unknown>, [unknown]>()
        .mockImplementation((callback: unknown) =>
          (callback as (tx: unknown) => Promise<unknown>)(prisma),
        ),
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

    // `prisma` needs the double cast (PrismaService is a class with far more
    // surface than these four members). `provider` does NOT: the mock object
    // is structurally a PaymentProvider already, so a cast there is both
    // flagged by no-unnecessary-type-assertion and actively harmful — it
    // would hide a port member added later behind `as unknown`.
    service = new PaymentsService(prisma as unknown as PrismaService, provider);
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

      await expect(
        service.initiate('user-2', 'order-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('409s for a cancelled order', async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...ORDER,
        status: OrderStatus.CANCELLED,
      });

      await expect(
        service.initiate('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('409s for an already paid order', async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...ORDER,
        status: OrderStatus.PAID,
      });

      await expect(
        service.initiate('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    /**
     * Phase 5. The money-path half of the EXPIRED lifecycle decision, and
     * the one that matters most: without this guard an EXPIRED order is
     * treated exactly as PENDING here, falls through to createPayment, and
     * takes money for inventory the expiry sweep already put back on sale.
     *
     * 409, matching the two guards above rather than §6.3's 422: the request
     * is well-formed and the amount is fine — it is the order's terminal
     * state, which the caller did not cause, that refuses it.
     */
    it('409s for an expired order and creates no intent', async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...ORDER,
        status: OrderStatus.EXPIRED,
      });

      await expect(service.initiate('user-1', 'order-1')).rejects.toThrow(
        'Order has expired',
      );
      await expect(
        service.initiate('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      // The assertion with the teeth: the refusal must happen ABOVE the
      // provider call, not merely somewhere in the method.
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    // EXPIRED must never be treated as PENDING, and PENDING must keep
    // working. Pinned together so a guard written with the wrong comparison
    // (or placed after the provider call) cannot pass both halves.
    it('still initiates for a PENDING order, so the guard is not over-broad', async () => {
      await expect(
        service.initiate('user-1', 'order-1'),
      ).resolves.toBeDefined();
      expect(provider.createPayment).toHaveBeenCalledTimes(1);
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

    // A client-supplied amount cannot reach the provider, because the service
    // takes no such argument: the only amount it can read is the persisted
    // one. This test pins that the persisted value — not the default fixture —
    // is what travels.
    it('sends a changed persisted amount, never a fixture default', async () => {
      prisma.order.findFirst.mockResolvedValue({ ...ORDER, totalCents: 7777 });

      await service.initiate('user-1', 'order-1');

      expect(provider.createPayment.mock.calls[0][0].amountMinorUnits).toBe(
        7777,
      );
    });

    it('consults amountLimits with the persisted currency', async () => {
      await service.initiate('user-1', 'order-1');

      expect(provider.amountLimits).toHaveBeenCalledWith('USD');
    });

    // A1: the limit check runs BEFORE the provider call, so an unpayable
    // order never creates an intent.
    it('422s above the maximum without calling the provider', async () => {
      prisma.order.findFirst.mockResolvedValue({
        ...ORDER,
        totalCents: 100_000_000,
      });

      await expect(
        service.initiate('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('422s below the minimum without calling the provider', async () => {
      prisma.order.findFirst.mockResolvedValue({ ...ORDER, totalCents: 49 });

      await expect(
        service.initiate('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    it('422s for an unsupported currency without calling the provider', async () => {
      provider.amountLimits.mockReturnValue(null);

      await expect(
        service.initiate('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(provider.createPayment).not.toHaveBeenCalled();
    });

    // The ordering claim, made independently of the limit values: the pure
    // check must be consulted before the network call, not merely alongside
    // it. Recorded as call order rather than as an absence.
    it('consults the limits before calling the provider', async () => {
      const order: string[] = [];

      provider.amountLimits.mockImplementation(() => {
        order.push('amountLimits');

        return { minMinorUnits: 50, maxMinorUnits: 99_999_999 };
      });
      provider.createPayment.mockImplementation(() => {
        order.push('createPayment');

        return Promise.resolve(CREATED);
      });

      await service.initiate('user-1', 'order-1');

      expect(order).toEqual(['amountLimits', 'createPayment']);
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

    it('never persists a clientSecret (S4)', async () => {
      await service.initiate('user-1', 'order-1');

      expect(
        JSON.stringify(prisma.payment.createMany.mock.calls),
      ).not.toContain('secret');
      expect(prisma.payment.createMany.mock.calls[0][0]).toEqual({
        data: {
          orderId: 'order-1',
          providerPaymentId: 'pi_1',
          status: PaymentStatus.PENDING,
        },
        skipDuplicates: true,
      });
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

      await expect(
        service.initiate('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(BadGatewayException);
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

      // Not `async`: there is nothing to await, and require-await rejects an
      // async function without one. Same shape FakePaymentProvider uses.
      provider.createPayment.mockImplementation(() => {
        assertOutside();

        return Promise.resolve(CREATED);
      });
      provider.retrievePayment.mockImplementation(() => {
        assertOutside();

        return Promise.resolve(CREATED);
      });

      await expect(
        service.initiate('user-1', 'order-1'),
      ).resolves.toBeDefined();
    });
  });
});
