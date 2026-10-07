import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfig } from '../../config/configuration';
import { MaintenanceJobName } from './maintenance-job-name.enum';
import { MaintenanceRunnerService } from './maintenance-runner.service';

/**
 * The scheduling seam, and nothing else. Every tick is a one-line delegate to
 * `MaintenanceRunnerService.run()`, which is also what the admin trigger and
 * every test call — so no test ever advances a timer or mocks a scheduler
 * (spec §9.2).
 *
 * Registration goes through `SchedulerRegistry` rather than `@Cron(...)`
 * because the expressions are configuration: a decorator argument is evaluated
 * when the class is defined, which would mean reading `process.env` in this
 * module body, and `src/config/` is the only place allowed to do that. Jobs
 * registered here are still stopped by `ScheduleModule` on shutdown, which
 * `app.enableShutdownHooks()` in `configureApp()` triggers.
 *
 * MAINTENANCE_JOBS_ENABLED=false registers nothing at all. The admin trigger
 * keeps working, which is exactly what the e2e suite needs: no background tick
 * racing a test's assertions (spec §14.7).
 */
@Injectable()
export class MaintenanceScheduler implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceScheduler.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly registry: SchedulerRegistry,
    private readonly runner: MaintenanceRunnerService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('maintenance.jobsEnabled', { infer: true })) {
      this.logger.warn(
        'MAINTENANCE_JOBS_ENABLED is false: no maintenance cron registered',
      );

      return;
    }

    // A typed Record, for the same reason the runner's job map is one: a new
    // MaintenanceJobName without a schedule is a compile error, not a job that
    // silently never ticks.
    const schedule: Record<MaintenanceJobName, string> = {
      [MaintenanceJobName.ORDER_EXPIRY]: this.config.get(
        'maintenance.orderExpiryCron',
        { infer: true },
      ),
      [MaintenanceJobName.MAINTENANCE_PURGE]: this.config.get(
        'maintenance.purgeCron',
        { infer: true },
      ),
      [MaintenanceJobName.PAYMENT_RECONCILIATION]: this.config.get(
        'maintenance.reconcileCron',
        { infer: true },
      ),
    };

    for (const [job, expression] of Object.entries(schedule) as [
      MaintenanceJobName,
      string,
    ][]) {
      this.registry.addCronJob(
        job,
        CronJob.from({
          cronTime: expression,
          onTick: () => this.tick(job),
          start: true,
        }),
      );
      this.logger.log(`Scheduled ${job} with "${expression}"`);
    }
  }

  /**
   * Catches here rather than in the runner: a rejected tick has no caller to
   * return to, and an unhandled rejection would take the process down over a
   * single failed maintenance pass. The lease is already released by the
   * runner's `finally`, so the next tick simply tries again (spec §9.5).
   */
  private async tick(job: MaintenanceJobName): Promise<void> {
    try {
      const summary = await this.runner.run(job);

      this.logger.log(
        `${job}: ${summary.status}${
          summary.reason === undefined ? '' : ` (${summary.reason})`
        } in ${summary.durationMs}ms — examined=${summary.examined} ` +
          `affected=${summary.affected} skipped=${summary.skipped} ` +
          `failed=${summary.failed}`,
      );
    } catch (error) {
      this.logger.error(
        `Maintenance job ${job} failed`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
