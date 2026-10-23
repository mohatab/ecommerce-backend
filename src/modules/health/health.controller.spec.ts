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
    // This is the assertion that NAMES the property: liveness must not depend
    // on the database. Asserting live() returns 200 while the database is UP
    // proves nothing, because every endpoint returns 200 then.
    it('still returns ok when the database is unreachable', () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      expect(controller.live()).toEqual({ status: 'ok' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('is synchronous, so it cannot await I/O', () => {
      expect(controller.live()).not.toBeInstanceOf(Promise);
    });
  });
});
