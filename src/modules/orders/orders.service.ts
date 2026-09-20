import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { OrderWithItems } from './dto/order-response.dto';
import { ProductsService } from '../products/products.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
  ) {}

  /** Always scoped to one user; there is no unscoped list route. */
  async listForUser(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<{ items: OrderWithItems[]; total: number }> {
    const where = { userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        skip: query.skip,
        take: query.limit,
        // `created_at` is TIMESTAMP(3), so two orders placed in the same
        // millisecond tie and the row order becomes arbitrary — which also
        // lets a row repeat or vanish across pages. `id` breaks the tie
        // deterministically: ids are uuid(7), time-ordered, so `id desc`
        // agrees with `createdAt desc` and never contradicts it.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { items: true },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items, total };
  }

  /** Another user's order is 404, not 403: existence must not leak. */
  async findOneForUser(
    userId: string,
    orderId: string,
  ): Promise<OrderWithItems> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  /**
   * The updateMany is a compare-and-swap: only the caller whose write matched
   * a PENDING row restores stock, so racing cancels restore EXACTLY ONCE.
   * Do not replace it with a read, a status check, and an update.
   */
  async cancel(userId: string, orderId: string): Promise<OrderWithItems> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, userId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });

      if (count === 0) {
        const existing = await tx.order.findFirst({
          where: { id: orderId, userId },
          include: { items: true },
        });

        // Unknown, or another user's: both are 404, so existence never leaks.
        if (!existing) {
          throw new NotFoundException('Order not found');
        }

        // Already cancelled: idempotent, and stock is NOT restored again.
        return existing;
      }

      const items = await tx.orderItem.findMany({
        where: { orderId },
        orderBy: { productId: 'asc' },
      });

      for (const item of items) {
        await this.productsService.incrementStock(
          tx,
          item.productId,
          item.quantity,
        );
      }

      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
    });
  }
}
