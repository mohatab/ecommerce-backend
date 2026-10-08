import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminMaintenanceController } from './admin-maintenance.controller';
import { MaintenanceLeaseModule } from './maintenance-lease.module';
import { MaintenancePurgeService } from './maintenance-purge.service';
import { MaintenanceRunnerService } from './maintenance-runner.service';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { OrderExpiryService } from './order-expiry.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { ReconciliationFindingWriter } from './reconciliation-finding.writer';

/**
 * Phase 5.
 *
 * OrdersModule is imported for OrdersService.expire(): orders writes stay in
 * the module that owns the table. There is no cycle, because the lease that
 * OrdersService needs back lives in MaintenanceLeaseModule, which depends on
 * no feature module.
 *
 * PaymentsModule is imported for PAYMENT_PROVIDER alone. No provider method
 * takes a Prisma.TransactionClient, which is the type-level guarantee that the
 * sweep's provider reads cannot happen inside a transaction.
 */
@Module({
  imports: [MaintenanceLeaseModule, OrdersModule, PaymentsModule],
  controllers: [AdminMaintenanceController],
  providers: [
    OrderExpiryService,
    MaintenancePurgeService,
    PaymentReconciliationService,
    ReconciliationFindingWriter,
    MaintenanceRunnerService,
    MaintenanceScheduler,
  ],
  // The runner is exported for the admin trigger, which reaches exactly the
  // same code path as the schedule. The lease is re-exported
  // so MaintenanceModule stays the one import a consumer needs.
  exports: [MaintenanceLeaseModule, MaintenanceRunnerService],
})
export class MaintenanceModule {}
