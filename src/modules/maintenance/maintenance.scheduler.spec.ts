import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfig } from '../../config/configuration';
import { MaintenanceJobName } from './maintenance-job-name.enum';
import { MaintenanceRunnerService } from './maintenance-runner.service';
import { MaintenanceScheduler } from './maintenance.scheduler';

describe('MaintenanceScheduler', () => {
  let registry: { addCronJob: jest.Mock<void, [string, CronJob]> };
  let runner: { run: jest.Mock };

  function schedulerWith(jobsEnabled: boolean): MaintenanceScheduler {
    const config = {
      get: (key: string): string | boolean =>
        key === 'maintenance.jobsEnabled' ? jobsEnabled : '0 */7 * * * *',
    } as unknown as ConfigService<AppConfig, true>;

    return new MaintenanceScheduler(
      config,
      registry as unknown as SchedulerRegistry,
      runner as unknown as MaintenanceRunnerService,
    );
  }

  beforeEach(() => {
    registry = { addCronJob: jest.fn<void, [string, CronJob]>() };
    runner = { run: jest.fn() };
  });

  afterEach(() => {
    // The jobs are started on registration, so leaving them running would leak
    // a real timer into the rest of the suite.
    for (const [, job] of registry.addCronJob.mock.calls) {
      // stop() is async in cron v4; nothing here needs to await the teardown.
      void job.stop();
    }
  });

  it('registers one cron per job name, at its configured expression', () => {
    schedulerWith(true).onModuleInit();

    expect(registry.addCronJob.mock.calls.map(([name]) => name)).toEqual(
      Object.values(MaintenanceJobName),
    );
    expect(registry.addCronJob.mock.calls[0][1].cronTime.source).toBe(
      '0 */7 * * * *',
    );
    // The delegate must not run anything at registration time.
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('registers nothing when maintenance jobs are disabled', () => {
    // The master switch the e2e suite relies on to stop a background tick
    // racing a test's assertions (spec §14.7).
    schedulerWith(false).onModuleInit();

    expect(registry.addCronJob).not.toHaveBeenCalled();
  });
});
