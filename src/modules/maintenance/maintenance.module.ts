import { Module } from '@nestjs/common';
import { MaintenanceLeaseService } from './maintenance-lease.service';

/**
 * Phase 5. Task 1 ships only the lease: nothing may depend on it until it is
 * proven to exclude a second holder (`test/maintenance-lease.e2e-spec.ts`).
 * The jobs that use it arrive in later tasks.
 */
@Module({
  providers: [MaintenanceLeaseService],
  exports: [MaintenanceLeaseService],
})
export class MaintenanceModule {}
