import { Injectable } from '@nestjs/common';
import { JobCounts, NO_WORK } from './job-counts';

/**
 * Task 6 owns the body (divergence detection and findings).
 *
 * Registered now for the same reason as MaintenancePurgeService: the runner's
 * job map must cover every MaintenanceJobName at compile time. Task 6 replaces
 * this body, not the wiring.
 */
@Injectable()
export class PaymentReconciliationService {
  run(): Promise<JobCounts> {
    return Promise.resolve({ ...NO_WORK });
  }
}
