import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ProductsService } from '../products/products.service';

type WhereArgs = [Record<string, unknown>];

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: {
    order: {
      findMany: jest.Mock<Promise<unknown[]>, WhereArgs>;
      count: jest.Mock<Promise<number>, WhereArgs>;
      findFirst: jest.Mock<Promise<unknown>, WhereArgs>;
    };
    $transaction: jest.Mock<Promise<unknown[]>, [Array<Promise<unknown>>]>;
  };
  let products: {
    incrementStock: jest.Mock<Promise<void>, [unknown, string, number]>;
  };

  beforeEach(() => {
    prisma = {
      order: {
        findMany: jest
          .fn<Promise<unknown[]>, WhereArgs>()
          .mockResolvedValue([]),
        count: jest.fn<Promise<number>, WhereArgs>().mockResolvedValue(0),
        findFirst: jest
          .fn<Promise<unknown>, WhereArgs>()
          .mockResolvedValue(null),
      },
      // The real $transaction([...]) form just awaits every promise in the
      // array and returns their resolved values in order.
      $transaction: jest
        .fn<Promise<unknown[]>, [Array<Promise<unknown>>]>()
        .mockImplementation((ops) => Promise.all(ops)),
    };
    products = {
      incrementStock: jest
        .fn<Promise<void>, [unknown, string, number]>()
        .mockResolvedValue(undefined),
    };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      products as unknown as ProductsService,
    );
  });

  describe('listForUser', () => {
    it('queries with the caller-scoped where, ordering, include and skip/take, and returns the transaction tuple', async () => {
      const orders = [{ id: 'order-1' }];
      prisma.order.findMany.mockResolvedValue(orders);
      prisma.order.count.mockResolvedValue(7);

      const query = new PaginationQueryDto();
      query.page = 2;
      query.limit = 10;

      const result = await service.listForUser('user-1', query);

      expect(prisma.order.findMany.mock.calls[0][0]).toEqual({
        where: { userId: 'user-1' },
        skip: 10,
        take: 10,
        // Tiebroken by id: without it, same-millisecond orders come back in
        // an arbitrary order and can repeat or vanish across pages.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { items: true },
      });
      expect(prisma.order.count.mock.calls[0][0]).toEqual({
        where: { userId: 'user-1' },
      });
      expect(result).toEqual({ items: orders, total: 7 });
    });
  });

  describe('findOneForUser', () => {
    it('queries with both id and userId in the where, and returns the order when found', async () => {
      const order = { id: 'order-1', userId: 'user-1' };
      prisma.order.findFirst.mockResolvedValue(order);

      const result = await service.findOneForUser('user-1', 'order-1');

      expect(prisma.order.findFirst.mock.calls[0][0]).toEqual({
        where: { id: 'order-1', userId: 'user-1' },
        include: { items: true },
      });
      expect(result).toBe(order);
    });

    it("throws NotFoundException when the query returns null, so another user's order 404s rather than 403s", async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.findOneForUser('user-1', 'someone-elses-order'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

type UpdateManyArgs = [
  { where: Record<string, unknown>; data: Record<string, unknown> },
];

describe('OrdersService.cancel', () => {
  let service: OrdersService;
  // Distinct from `prisma`, and returned by the $transaction mock below, so
  // every assertion on "was this called with the transaction client" fails
  // if the service ever slips and calls this.prisma directly instead of tx
  // (same pattern as checkout.service.spec.ts).
  let txMock: {
    order: {
      updateMany: jest.Mock<Promise<{ count: number }>, UpdateManyArgs>;
      findFirst: jest.Mock<Promise<unknown>, [unknown]>;
      findUniqueOrThrow: jest.Mock<Promise<unknown>, [unknown]>;
    };
    orderItem: { findMany: jest.Mock<Promise<unknown[]>, [unknown]> };
  };
  let prisma: {
    $transaction: jest.Mock<
      Promise<unknown>,
      [(tx: unknown) => Promise<unknown>]
    >;
  };
  let products: {
    incrementStock: jest.Mock<Promise<void>, [unknown, string, number]>;
  };

  beforeEach(() => {
    txMock = {
      order: {
        updateMany: jest
          .fn<Promise<{ count: number }>, UpdateManyArgs>()
          .mockResolvedValue({ count: 1 }),
        findFirst: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue(null),
        findUniqueOrThrow: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ id: 'order-1', items: [] }),
      },
      orderItem: {
        findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([
          { productId: 'a', quantity: 2 },
          { productId: 'b', quantity: 1 },
        ]),
      },
    };
    prisma = {
      $transaction: jest
        .fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>()
        .mockImplementation((callback) => callback(txMock)),
    };
    products = {
      incrementStock: jest
        .fn<Promise<void>, [unknown, string, number]>()
        .mockResolvedValue(undefined),
    };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      products as unknown as ProductsService,
    );
  });

  it('claims the order with a PENDING predicate in the WHERE clause', async () => {
    await service.cancel('user-1', 'order-1');

    expect(txMock.order.updateMany.mock.calls[0][0].where).toEqual({
      id: 'order-1',
      userId: 'user-1',
      status: OrderStatus.PENDING,
    });
  });

  it('restores stock in ascending productId order, via the transaction client', async () => {
    await service.cancel('user-1', 'order-1');

    expect(txMock.orderItem.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: { productId: 'asc' },
    });
    expect(products.incrementStock.mock.calls.map((call) => call[1])).toEqual([
      'a',
      'b',
    ]);
    expect(products.incrementStock).toHaveBeenCalledWith(txMock, 'a', 2);
    expect(products.incrementStock).toHaveBeenCalledWith(txMock, 'b', 1);
  });

  it('404s when the order does not exist or belongs to someone else', async () => {
    txMock.order.updateMany.mockResolvedValue({ count: 0 });
    txMock.order.findFirst.mockResolvedValue(null);

    await expect(service.cancel('user-1', 'order-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(products.incrementStock).not.toHaveBeenCalled();
  });

  it('is idempotent on an already-cancelled order and restores nothing twice', async () => {
    txMock.order.updateMany.mockResolvedValue({ count: 0 });
    txMock.order.findFirst.mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.CANCELLED,
      items: [],
    });

    await expect(service.cancel('user-1', 'order-1')).resolves.toMatchObject({
      id: 'order-1',
    });
    expect(products.incrementStock).not.toHaveBeenCalled();
  });

  it('409s on a PAID order and restores no stock', async () => {
    txMock.order.updateMany.mockResolvedValue({ count: 0 });
    txMock.order.findFirst.mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.PAID,
      items: [],
    });

    await expect(service.cancel('user-1', 'order-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // The whole point of the branch: a paid order's stock is never given back.
    expect(products.incrementStock).not.toHaveBeenCalled();
  });

  it('leaves the CAS predicate carrying status PENDING on the PAID path', async () => {
    txMock.order.updateMany.mockResolvedValue({ count: 0 });
    txMock.order.findFirst.mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.PAID,
      items: [],
    });

    await expect(service.cancel('user-1', 'order-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(txMock.order.updateMany.mock.calls[0][0].where).toEqual({
      id: 'order-1',
      userId: 'user-1',
      status: OrderStatus.PENDING,
    });
  });
});

describe('OrdersService.markPaid', () => {
  let service: OrdersService;
  let tx: {
    order: {
      updateMany: jest.Mock<Promise<{ count: number }>, UpdateManyArgs>;
      findUnique: jest.Mock<Promise<{ status: OrderStatus } | null>, [unknown]>;
    };
  };
  // A real recording mock, not `{}`: markPaid must operate through the tx it
  // was handed, and moving either the write or the classification read onto
  // this.prisma has to fail by ASSERTION here, not by crashing on undefined.
  let basePrisma: {
    order: {
      updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
      update: jest.Mock<Promise<unknown>, [unknown]>;
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    };
    $transaction: jest.Mock<Promise<unknown>, [unknown]>;
  };

  const expectBasePrismaUntouched = (): void => {
    expect(basePrisma.order.updateMany).not.toHaveBeenCalled();
    expect(basePrisma.order.update).not.toHaveBeenCalled();
    expect(basePrisma.order.findUnique).not.toHaveBeenCalled();
    expect(basePrisma.$transaction).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    tx = {
      order: {
        updateMany: jest
          .fn<Promise<{ count: number }>, UpdateManyArgs>()
          .mockResolvedValue({ count: 1 }),
        findUnique: jest
          .fn<Promise<{ status: OrderStatus } | null>, [unknown]>()
          .mockResolvedValue(null),
      },
    };
    basePrisma = {
      order: {
        updateMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
        update: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
        findUnique: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ status: OrderStatus.PENDING }),
      },
      $transaction: jest
        .fn<Promise<unknown>, [unknown]>()
        .mockResolvedValue(undefined),
    };

    service = new OrdersService(
      basePrisma as unknown as PrismaService,
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

  it('returns "not-found" for an unknown order, reading through the same tx', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    tx.order.findUnique.mockResolvedValue(null);

    expect(
      await service.markPaid(tx as unknown as Prisma.TransactionClient, 'o'),
    ).toBe('not-found');
    expect(tx.order.findUnique.mock.calls[0][0]).toEqual({
      where: { id: 'o' },
      select: { status: true },
    });
  });

  // It is called from a webhook. Throwing would surface as a 404 to the
  // provider, which reads that as "never retry".
  it('never throws on any of the CAS-miss paths', async () => {
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
  // rule decrementStock(tx, …) follows. Both directions are asserted: the tx
  // WAS used, and every base-prisma order method was NOT.
  it('uses only the transaction client it was given, on the CAS-hit path', async () => {
    await service.markPaid(
      tx as unknown as Prisma.TransactionClient,
      'order-1',
    );

    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expectBasePrismaUntouched();
  });

  it('uses only the transaction client it was given, on the CAS-miss path', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    tx.order.findUnique.mockResolvedValue({ status: OrderStatus.PAID });

    await service.markPaid(
      tx as unknown as Prisma.TransactionClient,
      'order-1',
    );

    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.order.findUnique).toHaveBeenCalledTimes(1);
    expectBasePrismaUntouched();
  });
});
