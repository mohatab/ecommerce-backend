import { NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

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

    service = new OrdersService(prisma as unknown as PrismaService);
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
