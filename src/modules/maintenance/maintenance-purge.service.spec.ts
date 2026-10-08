import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { MaintenancePurgeService } from './maintenance-purge.service';

const DAY_MS = 86_400_000;

interface Where {
  expiresAt?: { lt: Date };
  createdAt?: { lt: Date };
}
interface FindArgs {
  where: Where;
  take: number;
  orderBy: Record<string, string>;
}
type Find = jest.Mock<Promise<{ id: string }[]>, [FindArgs]>;
type Del = jest.Mock<Promise<{ count: number }>, [{ where: Where }]>;

function table(): { findMany: Find; deleteMany: Del } {
  return {
    findMany: jest
      .fn<Promise<{ id: string }[]>, [FindArgs]>()
      .mockResolvedValue([{ id: 'a' }, { id: 'b' }]),
    deleteMany: jest
      .fn<Promise<{ count: number }>, [{ where: Where }]>()
      .mockResolvedValue({ count: 2 }),
  };
}

describe('MaintenancePurgeService', () => {
  let service: MaintenancePurgeService;
  let prisma: {
    refreshToken: ReturnType<typeof table>;
    paymentEvent: ReturnType<typeof table>;
  };

  beforeEach(() => {
    prisma = { refreshToken: table(), paymentEvent: table() };
    const values: Record<string, number> = {
      'maintenance.refreshTokenRetentionDays': 30,
      'maintenance.paymentEventRetentionDays': 90,
      'maintenance.purgeBatchSize': 7,
    };
    const config = {
      get: (key: string): number => values[key],
    } as unknown as ConfigService<AppConfig, true>;
    service = new MaintenancePurgeService(
      prisma as unknown as PrismaService,
      config,
    );
  });

  it('cuts refresh tokens on expiresAt, never createdAt, bounded and oldest first', async () => {
    const before = Date.now();
    await service.run();

    const [args] = prisma.refreshToken.findMany.mock.calls[0];
    expect(args.where.createdAt).toBeUndefined();
    expect(args.where.expiresAt?.lt.getTime()).toBeLessThanOrEqual(
      before - 30 * DAY_MS + 1000,
    );
    expect(args.take).toBe(7);
    expect(args.orderBy).toEqual({ expiresAt: 'asc' });
    // The predicate travels with the delete, not just the id list.
    expect(prisma.refreshToken.deleteMany.mock.calls[0][0].where).toMatchObject(
      { id: { in: ['a', 'b'] }, expiresAt: args.where.expiresAt },
    );
  });

  it('cuts payment events on createdAt with the 90-day retention', async () => {
    const before = Date.now();
    await service.run();

    const [args] = prisma.paymentEvent.findMany.mock.calls[0];
    expect(args.where.createdAt?.lt.getTime()).toBeLessThanOrEqual(
      before - 90 * DAY_MS + 1000,
    );
    expect(args.take).toBe(7);
  });

  it('reports examined and affected across both tables', async () => {
    await expect(service.run()).resolves.toEqual({
      examined: 4,
      affected: 4,
      skipped: 0,
      failed: 0,
    });
  });

  it('still purges payment events when the refresh-token purge fails', async () => {
    prisma.refreshToken.findMany.mockRejectedValue(new Error('boom'));

    const counts = await service.run();

    expect(prisma.paymentEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ affected: 2, failed: 1 });
  });

  it('still purges refresh tokens when the payment-event purge fails', async () => {
    prisma.paymentEvent.deleteMany.mockRejectedValue(new Error('boom'));

    const counts = await service.run();

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ affected: 2, failed: 1 });
  });

  describe('saturation', () => {
    let warn: jest.SpyInstance<void, [message: unknown]>;

    beforeEach(() => {
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => warn.mockRestore());

    it('warns naming the table when a batch comes back full', async () => {
      // take is 7
      prisma.paymentEvent.findMany.mockResolvedValue(
        Array.from({ length: 7 }, (_, i) => ({ id: `e${i}` })),
      );

      await service.run();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('payment_events');
    });

    it('warns naming refresh_tokens when that batch comes back full', async () => {
      // take is 7
      prisma.refreshToken.findMany.mockResolvedValue(
        Array.from({ length: 7 }, (_, i) => ({ id: `t${i}` })),
      );

      await service.run();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('refresh_tokens');
    });

    it('does not warn when every batch is partial', async () => {
      await service.run();

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
