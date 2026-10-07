import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { JobCounts, NO_WORK } from './job-counts';
import { MaintenanceJobName } from './maintenance-job-name.enum';
import { MaintenanceLeaseService } from './maintenance-lease.service';
import { MaintenancePurgeService } from './maintenance-purge.service';
import { OrderExpiryService } from './order-expiry.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';

export interface JobSummary extends JobCounts {
  job: MaintenanceJobName;
  startedAt: Date;
  durationMs: number;
  status: 'completed' | 'skipped';
  reason?: 'lease-held' | 'lease-missing' | 'disabled';
}

/**
 * The one way a maintenance job is ever invoked: the cron delegates call this,
 * and so will the admin trigger. Tests call it directly, so no timer is ever
 * advanced and no scheduler is ever mocked (spec §9.2).
 *
 * It owns the lease lifecycle — acquire, heartbeat, release — and nothing
 * about what any job does. The lease prevents DUPLICATE work; it is never what
 * makes the work correct. Correctness is the per-row CAS and the in-transaction
 * fencing inside each job (spec §9.3.4).
 */
@Injectable()
export class MaintenanceRunnerService {
  private readonly logger = new Logger(MaintenanceRunnerService.name);

  /**
   * A typed Record, so adding a MaintenanceJobName without a runner entry is a
   * compile error. No string ever selects a method here.
   */
  private readonly jobs: Record<MaintenanceJobName, () => Promise<JobCounts>>;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly lease: MaintenanceLeaseService,
    expiry: OrderExpiryService,
    purge: MaintenancePurgeService,
    reconciliation: PaymentReconciliationService,
  ) {
    this.jobs = {
      [MaintenanceJobName.ORDER_EXPIRY]: () => expiry.sweep(),
      [MaintenanceJobName.MAINTENANCE_PURGE]: () => purge.run(),
      [MaintenanceJobName.PAYMENT_RECONCILIATION]: () => reconciliation.run(),
    };
  }

  async run(job: MaintenanceJobName): Promise<JobSummary> {
    const startedAt = new Date();
    const outcome = await this.lease.acquire(job);

    if (outcome !== 'acquired') {
      // 'missing' is an operational fault, not routine contention, so it is
      // error-level: the job is silently unrunnable until the row is restored.
      if (outcome === 'missing') {
        this.logger.error(
          `No maintenance lease row for ${job}; job cannot run`,
        );
      } else {
        this.logger.warn(`Lease for ${job} is held elsewhere; skipping tick`);
      }

      return {
        job,
        startedAt,
        durationMs: 0,
        status: 'skipped',
        reason: outcome === 'held' ? 'lease-held' : 'lease-missing',
        ...NO_WORK,
      };
    }

    // A third of the lease, so several consecutive renewals can be delayed
    // without the lease lapsing under a run that is still alive.
    const timer = setInterval(
      () => {
        // Not a floating promise: an unhandled rejection here would take the
        // process down during what is, at worst, a lost lease that the next
        // assertHeld() will catch anyway.
        this.lease.heartbeat(job).catch((error: unknown) => {
          this.logger.warn(
            `Heartbeat for ${job} failed: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        });
      },
      (this.config.get('maintenance.leaseSeconds', { infer: true }) * 1000) / 3,
    );

    try {
      const counts = await this.jobs[job]();

      return {
        job,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        status: 'completed',
        ...counts,
      };
    } finally {
      // finally, not catch: a failed tick must still free the lease, or the
      // job is unrunnable until the lease lapses. The error itself propagates
      // to the caller, which decides how loudly to report it (spec §9.5).
      clearInterval(timer);

      // Caught, never rethrown: a rejection thrown out of `finally` REPLACES
      // whatever the job threw — including LeaseLostError — so an operator
      // reading the logs would be told the release failed and never told why
      // the tick did. The lease lapses on its own within
      // MAINTENANCE_LEASE_SECONDS either way, so losing the release costs at
      // most one skipped tick; losing the original error costs the diagnosis.
      await this.lease.release(job).catch((error: unknown) => {
        this.logger.error(
          `Failed to release the lease for ${job}; it will lapse on its own`,
          error instanceof Error ? error.stack : undefined,
        );
      });
    }
  }
}
