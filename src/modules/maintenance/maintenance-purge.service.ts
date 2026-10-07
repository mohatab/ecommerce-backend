import { Injectable } from '@nestjs/common';
import { JobCounts, NO_WORK } from './job-counts';

/**
 * Task 5 owns the body (refresh_tokens and payment_events retention).
 *
 * It is registered now, doing nothing, because the runner's job map is a
 * `Record<MaintenanceJobName, …>`: a missing entry is a compile error, which
 * is what stops a job name from being silently unrunnable. Task 5 replaces
 * this body, not the wiring.
 */
@Injectable()
export class MaintenancePurgeService {
  run(): Promise<JobCounts> {
    return Promise.resolve({ ...NO_WORK });
  }
}
