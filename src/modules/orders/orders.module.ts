import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { CartModule } from '../cart/cart.module';
import { ProductsModule } from '../products/products.module';

// ProductsModule and CartModule are unused by Task 4's read-only routes, but
// stay imported here because the checkout and cancel tasks that follow build
// on OrdersModule already depending on both.
@Module({
  imports: [ProductsModule, CartModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
