import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaService } from '../../prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('returns ok status when the database is reachable', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(typeof result.timestamp).toBe('string');
  });

  it('throws ServiceUnavailableException when the database is unreachable', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connection refused'));

    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  describe('live', () => {
    it('returns ok without touching the database', () => {
      const result = controller.live();

      expect(result).toEqual({ status: 'ok' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    // C-D3, unit half. The container half lives in T6.
    //
    // Liveness must not depend on the database, and that only shows in the
    // database-DOWN state: asserting 200 while the database is up proves
    // nothing, because every endpoint returns 200 then. The result is awaited
    // through Promise.resolve so a regressed async live() fails an assertion
    // instead of an unhandled rejection killing the worker.
    //
    // Ceiling: this proves live() does not call the injected Prisma mock. It
    // cannot see other I/O (fs, a sync config read). Zero-I/O is observable
    // only in T6's container half.
    it('still returns ok when the database is unreachable', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      const result: unknown = controller.live();
      await expect(Promise.resolve(result)).resolves.toEqual({ status: 'ok' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    // Ceiling: proves "not async", not "no I/O" (a sync fs read would pass).
    it('is synchronous, so it cannot await I/O', () => {
      expect(controller.live()).not.toBeInstanceOf(Promise);
    });
  });
});
