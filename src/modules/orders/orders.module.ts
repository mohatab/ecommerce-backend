import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { CheckoutService } from './checkout.service';
import { CartModule } from '../cart/cart.module';
import { ProductsModule } from '../products/products.module';
import { MaintenanceLeaseModule } from '../maintenance/maintenance-lease.module';

@Module({
  // MaintenanceLeaseModule, not MaintenanceModule: expire() needs the lease
  // to fence its transaction (spec §4.5), and the lease module depends on no
  // feature module — so importing it here keeps the module graph a DAG.
  imports: [ProductsModule, CartModule, MaintenanceLeaseModule],
  controllers: [OrdersController],
  providers: [OrdersService, CheckoutService],
  // OrdersService only: PaymentsModule will call markPaid, so orders writes
  // stay inside the module that owns the table (D9, C6). CheckoutService has
  // no caller outside this module and is deliberately not exported.
  exports: [OrdersService],
})
export class OrdersModule {}
