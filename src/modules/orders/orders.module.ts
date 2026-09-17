import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { CheckoutService } from './checkout.service';
import { CartModule } from '../cart/cart.module';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [ProductsModule, CartModule],
  controllers: [OrdersController],
  providers: [OrdersService, CheckoutService],
})
export class OrdersModule {}
