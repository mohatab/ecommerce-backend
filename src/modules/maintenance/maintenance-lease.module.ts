import { Module } from '@nestjs/common';
import { MaintenanceLeaseService } from './maintenance-lease.service';

/**
 * The lease on its own, so the module graph stays a DAG.
 *
 * `OrdersService.expire()` needs `MaintenanceLeaseService` — the fencing check
 * has to share a transaction with the write it protects, so it cannot be
 * hoisted out of the orders call stack — while `MaintenanceModule` needs
 * `OrdersService`. Importing `MaintenanceModule` from `OrdersModule` closes
 * three cycles at once (`Orders → Maintenance → Orders` and
 * `Orders → Maintenance → Payments → Orders`), and `forwardRef()` does not
 * save it: under CommonJS the partially-initialised `orders.module` leaves
 * `PaymentsModule`'s own plain `imports: [OrdersModule]` evaluating to
 * `[undefined]`, which fails the scan with a misleading error.
 *
 * Splitting the lease out is the structural fix rather than the patch: nothing
 * here depends on any feature module, so every consumer can import it freely.
 */
@Module({
  providers: [MaintenanceLeaseService],
  exports: [MaintenanceLeaseService],
})
export class MaintenanceLeaseModule {}
