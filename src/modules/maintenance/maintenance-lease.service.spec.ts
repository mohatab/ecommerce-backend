import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MaintenanceJobName } from './maintenance-job-name.enum';
import {
  LeaseLostError,
  MaintenanceLeaseService,
} from './maintenance-lease.service';

// Typed rather than bare `jest.Mock`: these tests read recorded call
// arguments, and `jest.Mock` is `Mock<any, any, any>`, which trips
// @typescript-eslint/no-unsafe-member-access under `npm run lint:ci`.
type UpdateManyMock = jest.Mock<
  Promise<{ count: number }>,
  [Prisma.MaintenanceLeaseUpdateManyArgs]
>;
type CountMock = jest.Mock<Promise<number>, [Prisma.MaintenanceLeaseCountArgs]>;

// `expect.any` is declared as `any`, which trips no-unsafe-assignment inside a
// typed object literal under `npm run lint:ci`. The matcher is a sentinel, not
// a value, so naming it once here keeps the single cast out of every test.
const ANY_DATE = expect.any(Date) as Date;

describe('MaintenanceLeaseService', () => {
  let service: MaintenanceLeaseService;
  let prisma: {
    maintenanceLease: { updateMany: UpdateManyMock; count: CountMock };
  };

  beforeEach(async () => {
    prisma = {
      maintenanceLease: {
        updateMany: jest.fn<
          Promise<{ count: number }>,
          [Prisma.MaintenanceLeaseUpdateManyArgs]
        >(),
        count: jest.fn<Promise<number>, [Prisma.MaintenanceLeaseCountArgs]>(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        MaintenanceLeaseService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => 300 } },
      ],
    }).compile();

    service = module.get(MaintenanceLeaseService);
  });

  describe('acquire', () => {
    it('reports acquired when the CAS matches one row', async () => {
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.acquire(MaintenanceJobName.ORDER_EXPIRY),
      ).resolves.toBe('acquired');
    });

    it('reports held when the CAS matches nothing but the row exists', async () => {
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 0 });
      prisma.maintenanceLease.count.mockResolvedValue(1);

      await expect(
        service.acquire(MaintenanceJobName.ORDER_EXPIRY),
      ).resolves.toBe('held');
    });

    it('reports missing when the row itself is absent', async () => {
      // A deleted lease row makes the job unrunnable forever, and 'held' would
      // hide that behind a routine warn.
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 0 });
      prisma.maintenanceLease.count.mockResolvedValue(0);

      await expect(
        service.acquire(MaintenanceJobName.ORDER_EXPIRY),
      ).resolves.toBe('missing');
    });

    it('carries the lapsed-or-free predicate with the write, and claims the row for this instance', async () => {
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 1 });

      await service.acquire(MaintenanceJobName.ORDER_EXPIRY);

      const [args] = prisma.maintenanceLease.updateMany.mock.calls[0];

      // A read-then-check-then-update would let two instances both pass the
      // check. The predicate has to travel with the write.
      expect(args.where).toEqual({
        job: MaintenanceJobName.ORDER_EXPIRY,
        expiresAt: { lte: ANY_DATE },
      });
      expect(args.data).toMatchObject({ holder: service.instanceId });
    });

    it('extends the lease by the configured number of seconds', async () => {
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 1 });

      await service.acquire(MaintenanceJobName.ORDER_EXPIRY);

      const [args] = prisma.maintenanceLease.updateMany.mock.calls[0];
      const acquiredAt = args.data.acquiredAt as Date;
      const expiresAt = args.data.expiresAt as Date;

      expect(expiresAt.getTime() - acquiredAt.getTime()).toBe(300_000);
    });
  });

  describe('heartbeat', () => {
    it('returns true while this instance still holds the lease', async () => {
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.heartbeat(MaintenanceJobName.ORDER_EXPIRY),
      ).resolves.toBe(true);
    });

    it('returns false when another instance has taken the lease', async () => {
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.heartbeat(MaintenanceJobName.ORDER_EXPIRY),
      ).resolves.toBe(false);
    });

    it('renews only its own lease, never a foreign one', async () => {
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 1 });

      await service.heartbeat(MaintenanceJobName.ORDER_EXPIRY);

      const [args] = prisma.maintenanceLease.updateMany.mock.calls[0];

      expect(args.where).toEqual({
        job: MaintenanceJobName.ORDER_EXPIRY,
        holder: service.instanceId,
      });
    });
  });

  describe('release', () => {
    it('is holder-scoped, so a late release cannot free another instance lease', async () => {
      prisma.maintenanceLease.updateMany.mockResolvedValue({ count: 1 });

      await service.release(MaintenanceJobName.ORDER_EXPIRY);

      const [args] = prisma.maintenanceLease.updateMany.mock.calls[0];

      expect(args.where).toEqual({
        job: MaintenanceJobName.ORDER_EXPIRY,
        holder: service.instanceId,
      });
      expect(args.data).toEqual({ holder: '', expiresAt: new Date(0) });
    });
  });

  describe('assertHeld', () => {
    function txWithCount(count: number): {
      maintenanceLease: { updateMany: UpdateManyMock };
    } {
      return {
        maintenanceLease: {
          updateMany: jest
            .fn<
              Promise<{ count: number }>,
              [Prisma.MaintenanceLeaseUpdateManyArgs]
            >()
            .mockResolvedValue({ count }),
        },
      };
    }

    it('throws LeaseLostError when the lease is gone', async () => {
      await expect(
        service.assertHeld(
          txWithCount(0) as never,
          MaintenanceJobName.ORDER_EXPIRY,
        ),
      ).rejects.toThrow(LeaseLostError);
    });

    it('resolves while the lease is still held and unexpired', async () => {
      await expect(
        service.assertHeld(
          txWithCount(1) as never,
          MaintenanceJobName.ORDER_EXPIRY,
        ),
      ).resolves.toBeUndefined();
    });

    it('runs on the caller transaction client, never on this.prisma', async () => {
      // The whole guarantee: the check and the mutation it protects must share
      // one transaction. Reaching for this.prisma would run it on a different
      // connection outside the transaction and guarantee nothing.
      const tx = txWithCount(1);

      await service.assertHeld(tx as never, MaintenanceJobName.ORDER_EXPIRY);

      expect(tx.maintenanceLease.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.maintenanceLease.updateMany).not.toHaveBeenCalled();
    });

    it('requires an unexpired lease held by this instance', async () => {
      const tx = txWithCount(1);

      await service.assertHeld(tx as never, MaintenanceJobName.ORDER_EXPIRY);

      const [args] = tx.maintenanceLease.updateMany.mock.calls[0];

      expect(args.where).toEqual({
        job: MaintenanceJobName.ORDER_EXPIRY,
        holder: service.instanceId,
        expiresAt: { gt: ANY_DATE },
      });
    });
  });

  it('gives each instance a distinct identity', async () => {
    const other = await Test.createTestingModule({
      providers: [
        MaintenanceLeaseService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => 300 } },
      ],
    }).compile();

    expect(other.get(MaintenanceLeaseService).instanceId).not.toBe(
      service.instanceId,
    );
  });
});
