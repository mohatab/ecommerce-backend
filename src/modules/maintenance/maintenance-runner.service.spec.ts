import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { JobCounts } from './job-counts';
import { MaintenanceJobName } from './maintenance-job-name.enum';
import {
  AcquireOutcome,
  MaintenanceLeaseService,
} from './maintenance-lease.service';
import { MaintenanceRunnerService } from './maintenance-runner.service';
import { OrderExpiryService } from './order-expiry.service';

// `expect.any` is declared as `any`, which trips no-unsafe-assignment inside
// a typed object literal under `npm run lint:ci`. Named once, as the lease
// spec does.
const ANY_DATE = expect.any(Date) as Date;

const COUNTS: JobCounts = {
  examined: 3,
  affected: 2,
  skipped: 1,
  failed: 0,
};

describe('MaintenanceRunnerService', () => {
  let runner: MaintenanceRunnerService;
  let lease: {
    acquire: jest.Mock<Promise<AcquireOutcome>, [MaintenanceJobName]>;
    heartbeat: jest.Mock<Promise<boolean>, [MaintenanceJobName]>;
    release: jest.Mock<Promise<void>, [MaintenanceJobName]>;
  };
  let expiry: { sweep: jest.Mock<Promise<JobCounts>, []> };
  let purge: { run: jest.Mock<Promise<JobCounts>, []> };
  let reconciliation: { run: jest.Mock<Promise<JobCounts>, []> };

  beforeEach(() => {
    lease = {
      acquire: jest
        .fn<Promise<AcquireOutcome>, [MaintenanceJobName]>()
        .mockResolvedValue('acquired'),
      heartbeat: jest
        .fn<Promise<boolean>, [MaintenanceJobName]>()
        .mockResolvedValue(true),
      release: jest
        .fn<Promise<void>, [MaintenanceJobName]>()
        .mockResolvedValue(undefined),
    };
    expiry = {
      sweep: jest.fn<Promise<JobCounts>, []>().mockResolvedValue(COUNTS),
    };
    purge = {
      run: jest.fn<Promise<JobCounts>, []>().mockResolvedValue(COUNTS),
    };
    reconciliation = {
      run: jest.fn<Promise<JobCounts>, []>().mockResolvedValue(COUNTS),
    };

    runner = new MaintenanceRunnerService(
      { get: () => 300 } as unknown as ConfigService<AppConfig, true>,
      lease as unknown as MaintenanceLeaseService,
      expiry as unknown as OrderExpiryService,
      purge,
      reconciliation,
    );
  });

  it('runs the mapped job under the lease and returns its counts', async () => {
    const summary = await runner.run(MaintenanceJobName.ORDER_EXPIRY);

    expect(lease.acquire).toHaveBeenCalledWith(MaintenanceJobName.ORDER_EXPIRY);
    expect(expiry.sweep).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      job: MaintenanceJobName.ORDER_EXPIRY,
      status: 'completed',
      ...COUNTS,
    });
    expect(summary.reason).toBeUndefined();
    expect(lease.release).toHaveBeenCalledWith(MaintenanceJobName.ORDER_EXPIRY);
  });

  it('maps every job name, so none is silently unrunnable', async () => {
    for (const job of Object.values(MaintenanceJobName)) {
      await expect(runner.run(job)).resolves.toMatchObject({
        job,
        status: 'completed',
      });
    }

    expect(expiry.sweep).toHaveBeenCalledTimes(1);
    expect(purge.run).toHaveBeenCalledTimes(1);
    expect(reconciliation.run).toHaveBeenCalledTimes(1);
  });

  it('skips without running the job when another instance holds the lease', async () => {
    lease.acquire.mockResolvedValue('held');

    await expect(runner.run(MaintenanceJobName.ORDER_EXPIRY)).resolves.toEqual({
      job: MaintenanceJobName.ORDER_EXPIRY,
      startedAt: ANY_DATE,
      durationMs: 0,
      status: 'skipped',
      reason: 'lease-held',
      examined: 0,
      affected: 0,
      skipped: 0,
      failed: 0,
    });
    expect(expiry.sweep).not.toHaveBeenCalled();
    // Nothing was acquired, so nothing may be released — a release here would
    // be a no-op only because release() is holder-scoped.
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('reports a missing lease row distinctly from a held one', async () => {
    lease.acquire.mockResolvedValue('missing');

    await expect(
      runner.run(MaintenanceJobName.ORDER_EXPIRY),
    ).resolves.toMatchObject({ status: 'skipped', reason: 'lease-missing' });
  });

  it('releases the lease even when the job throws', async () => {
    expiry.sweep.mockRejectedValue(new Error('sweep exploded'));

    await expect(runner.run(MaintenanceJobName.ORDER_EXPIRY)).rejects.toThrow(
      'sweep exploded',
    );
    expect(lease.release).toHaveBeenCalledWith(MaintenanceJobName.ORDER_EXPIRY);
  });

  it('lets the job error through when releasing the lease also fails', async () => {
    // A rejection thrown out of `finally` would replace the job's error with
    // a less informative one, at exactly the moment the truth matters most.
    expiry.sweep.mockRejectedValue(new Error('sweep exploded'));
    lease.release.mockRejectedValue(new Error('database gone'));

    await expect(runner.run(MaintenanceJobName.ORDER_EXPIRY)).rejects.toThrow(
      'sweep exploded',
    );
  });

  it('still returns the summary when only releasing the lease fails', async () => {
    lease.release.mockRejectedValue(new Error('database gone'));

    await expect(
      runner.run(MaintenanceJobName.ORDER_EXPIRY),
    ).resolves.toMatchObject({ status: 'completed', ...COUNTS });
  });

  it('heartbeats while the job runs and stops once it is done', async () => {
    jest.useFakeTimers();

    try {
      let finish: (() => void) | undefined;
      expiry.sweep.mockReturnValue(
        new Promise<JobCounts>((resolve) => {
          finish = () => resolve(COUNTS);
        }),
      );

      const running = runner.run(MaintenanceJobName.ORDER_EXPIRY);

      // Let acquire() settle so the interval is actually armed.
      await Promise.resolve();
      await Promise.resolve();

      // leaseSeconds / 3 == 100s, so the lease can never lapse mid-run.
      jest.advanceTimersByTime(100_000);
      expect(lease.heartbeat).toHaveBeenCalledTimes(1);

      finish!();
      await running;

      jest.advanceTimersByTime(1_000_000);
      expect(lease.heartbeat).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
