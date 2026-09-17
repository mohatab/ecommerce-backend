import { NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
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
        orderBy: { createdAt: 'desc' },
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
});
