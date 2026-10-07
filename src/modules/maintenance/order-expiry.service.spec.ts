import { OrderStatus, PaymentStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import {
  PaymentProvider,
  ProviderPayment,
  ProviderPaymentNotFoundError,
} from '../payments/provider/payment-provider';
import { LeaseLostError } from './maintenance-lease.service';
import { OrderExpiryService } from './order-expiry.service';

const HOUR_MS = 3_600_000;

interface Candidate {
  id: string;
  payment: { providerPaymentId: string; createdAt: Date } | null;
}

function tierA(id: string): Candidate {
  return { id, payment: null };
}

/** Tier B, with a payment old enough to be past the 24-hour gate. */
function tierB(id: string, ageHours = 48): Candidate {
  return {
    id,
    payment: {
      providerPaymentId: `pi_${id}`,
      createdAt: new Date(Date.now() - ageHours * HOUR_MS),
    },
  };
}

function providerPayment(
  status: ProviderPayment['status'],
): Promise<ProviderPayment> {
  return Promise.resolve({
    providerPaymentId: 'pi_x',
    clientSecret: 'secret',
    amountMinorUnits: 1000,
    currency: 'USD',
    status,
  });
}

describe('OrderExpiryService', () => {
  let service: OrderExpiryService;
  let prisma: {
    order: { findMany: jest.Mock<Promise<Candidate[]>, [unknown]> };
    $transaction: jest.Mock<Promise<unknown>, [unknown]>;
  };
  let orders: { expire: jest.Mock<Promise<'expired' | 'raced'>, [string]> };
  let provider: {
    retrievePayment: jest.Mock<Promise<ProviderPayment>, [string]>;
  };

  beforeEach(() => {
    prisma = {
      order: {
        findMany: jest
          .fn<Promise<Candidate[]>, [unknown]>()
          .mockResolvedValue([]),
      },
      // A recording mock that must stay untouched: the sweep itself opens no
      // transaction, because a provider call may never happen inside one.
      $transaction: jest
        .fn<Promise<unknown>, [unknown]>()
        .mockResolvedValue(undefined),
    };
    orders = {
      expire: jest
        .fn<Promise<'expired' | 'raced'>, [string]>()
        .mockResolvedValue('expired'),
    };
    provider = {
      retrievePayment: jest
        .fn<Promise<ProviderPayment>, [string]>()
        .mockImplementation(() => providerPayment('pending')),
    };

    const config = {
      get: (key: string): number =>
        key === 'maintenance.orderExpiryBatchSize' ? 100 : 24,
    } as unknown as ConfigService<AppConfig, true>;

    service = new OrderExpiryService(
      prisma as unknown as PrismaService,
      config,
      orders as unknown as OrdersService,
      provider as unknown as PaymentProvider,
    );
  });

  it('selects only PENDING orders whose deadline has arrived, oldest first', async () => {
    await service.sweep();

    const [args] = prisma.order.findMany.mock.calls[0] as [
      {
        where: Record<string, unknown>;
        orderBy: unknown;
        take: number;
      },
    ];

    // `lte`, not `lt`: an order whose deadline is exactly the query instant
    // must be selected (spec §5.4).
    expect(args.where).toMatchObject({
      status: OrderStatus.PENDING,
      expiresAt: { not: null, lte: expect.any(Date) as Date },
      OR: [
        { payment: { is: null } },
        { payment: { is: { status: PaymentStatus.PENDING } } },
      ],
    });
    expect(args.orderBy).toEqual({ expiresAt: 'asc' });
    expect(args.take).toBe(100);
  });

  it('expires a tier-A candidate without consulting the provider', async () => {
    prisma.order.findMany.mockResolvedValue([tierA('order-1')]);

    await expect(service.sweep()).resolves.toEqual({
      examined: 1,
      affected: 1,
      skipped: 0,
      failed: 0,
    });
    // Tier A has no providerPaymentId, so there is nothing to look up.
    expect(provider.retrievePayment).not.toHaveBeenCalled();
    expect(orders.expire).toHaveBeenCalledWith('order-1');
  });

  it('opens no transaction of its own, so no provider call can be inside one', async () => {
    prisma.order.findMany.mockResolvedValue([tierB('order-1')]);

    await service.sweep();

    expect(provider.retrievePayment).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not expire a tier-B candidate still inside its payment-started gate', async () => {
    prisma.order.findMany.mockResolvedValue([tierB('order-1', 1)]);

    await expect(service.sweep()).resolves.toMatchObject({
      affected: 0,
      skipped: 1,
    });
    expect(provider.retrievePayment).not.toHaveBeenCalled();
    expect(orders.expire).not.toHaveBeenCalled();
  });

  it('does not expire a tier-B candidate the provider reports succeeded', async () => {
    prisma.order.findMany.mockResolvedValue([tierB('order-1')]);
    provider.retrievePayment.mockImplementation(() =>
      providerPayment('succeeded'),
    );

    await expect(service.sweep()).resolves.toMatchObject({
      affected: 0,
      skipped: 1,
      failed: 0,
    });
    expect(orders.expire).not.toHaveBeenCalled();
  });

  it('does not expire a tier-B candidate the provider does not recognise', async () => {
    prisma.order.findMany.mockResolvedValue([tierB('order-1')]);
    provider.retrievePayment.mockRejectedValue(
      new ProviderPaymentNotFoundError('pi_order-1'),
    );

    await expect(service.sweep()).resolves.toMatchObject({
      affected: 0,
      skipped: 1,
      failed: 0,
    });
    expect(orders.expire).not.toHaveBeenCalled();
  });

  it('does not expire a tier-B candidate when the provider read fails', async () => {
    prisma.order.findMany.mockResolvedValue([tierB('order-1')]);
    provider.retrievePayment.mockRejectedValue(new Error('Provider timeout'));

    await expect(service.sweep()).resolves.toMatchObject({
      affected: 0,
      failed: 1,
    });
    expect(orders.expire).not.toHaveBeenCalled();
  });

  it('counts a lost CAS race as skipped, never as affected', async () => {
    prisma.order.findMany.mockResolvedValue([tierA('order-1')]);
    orders.expire.mockResolvedValue('raced');

    await expect(service.sweep()).resolves.toMatchObject({
      affected: 0,
      skipped: 1,
    });
  });

  it('counts a per-order failure and still examines the rest of the batch', async () => {
    prisma.order.findMany.mockResolvedValue([tierA('a'), tierA('b')]);
    orders.expire.mockRejectedValueOnce(new Error('deadlock'));

    await expect(service.sweep()).resolves.toMatchObject({
      examined: 2,
      affected: 1,
      failed: 1,
    });
    expect(orders.expire).toHaveBeenCalledTimes(2);
  });

  it('aborts the whole sweep the moment the lease is lost', async () => {
    prisma.order.findMany.mockResolvedValue([tierA('a'), tierA('b')]);
    orders.expire.mockRejectedValueOnce(new LeaseLostError('order-expiry'));

    await expect(service.sweep()).rejects.toBeInstanceOf(LeaseLostError);
    // The second order is never attempted: another instance now owns the job.
    expect(orders.expire).toHaveBeenCalledTimes(1);
  });
});
