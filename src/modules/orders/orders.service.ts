import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { OrderWithItems } from './dto/order-response.dto';
import { ProductsService } from '../products/products.service';

/** The five ways markPaid can end. It never throws, so this is the whole API. */
export type MarkPaidOutcome =
  'paid' | 'already-paid' | 'cancelled' | 'expired' | 'not-found';

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

        // Phase 4: a paid order cannot be cancelled. Restoring its stock
        // would give back goods that were paid for and would owe a refund,
        // which is out of scope (spec §4.3). A different answer from the
        // already-cancelled case below, so the two branches are split.
        if (existing.status === OrderStatus.PAID) {
          throw new ConflictException('Order is already paid');
        }

        // Phase 5: the expiry sweep already released this order's stock, so a
        // cancel here would restore it a second time. Distinct from the
        // already-cancelled case below, which returns 200: the customer asked
        // to cancel something that is no longer theirs to cancel, and a silent
        // 200 would read as "we cancelled it for you".
        if (existing.status === OrderStatus.EXPIRED) {
          throw new ConflictException('Order has expired');
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

  /**
   * The ONLY writer of OrderStatus.PAID anywhere in src/ (D9, C6).
   *
   * `tx` is REQUIRED, with no default, exactly as
   * ProductsService.decrementStock(tx, …) is: the write must run inside the
   * caller's transaction — the webhook's — so the event insert, the payment
   * promotion and this transition commit or roll back together. Nothing here
   * touches this.prisma.
   *
   * The updateMany is a compare-and-swap: only the caller whose write matched
   * a PENDING row transitions the order, so duplicate or concurrent webhook
   * deliveries transition it EXACTLY ONCE. Do not replace it with a read, a
   * status check and an update.
   *
   * It NEVER throws. Its caller is a webhook handler, and a thrown
   * NotFoundException would reach the payment provider as a 404 — which most
   * providers read as "this event is permanently rejected, stop retrying".
   * The outcome is returned instead and the caller chooses the response,
   * which for the webhook is always 200.
   */
  async markPaid(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<MarkPaidOutcome> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING },
      data: { status: OrderStatus.PAID },
    });

    if (count === 1) {
      return 'paid';
    }

    // Same shape as cancel()'s CAS-miss branch: classify by reading the row,
    // through the same tx so it sees the caller's uncommitted writes.
    const existing = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });

    if (existing === null) {
      return 'not-found';
    }

    // An exhaustive switch, not a ternary with a fallthrough: every status
    // this method recognises is named, so adding another OrderStatus member
    // makes the switch non-exhaustive and the function fail to compile
    // ("lacks ending return statement"). That forces a deliberate decision
    // for the new status instead of silently labelling it 'cancelled'.
    switch (existing.status) {
      case OrderStatus.PAID:
        return 'already-paid';
      case OrderStatus.CANCELLED:
        return 'cancelled';
      // Phase 5. Reported distinctly, not folded into 'cancelled': a payment
      // arriving for an order the expiry sweep already released is the one
      // case where stock was restored and sold on while money moved, so the
      // webhook's handler needs to tell it apart to log it as what it is. The
      // transition itself is still refused — EXPIRED is terminal, and this
      // method stays the only writer of PAID.
      case OrderStatus.EXPIRED:
        return 'expired';
      case OrderStatus.PENDING:
        // Unreachable in practice: PostgreSQL re-evaluates the CAS predicate
        // against the committed row, so a row this call failed to claim
        // cannot still be PENDING. Deliberately reported as 'cancelled'
        // anyway, because that is the only one of the four outcomes that is
        // safe when the state is anomalous — it neither claims the payment
        // succeeded ('paid'/'already-paid') nor that the order is absent
        // ('not-found'), and it routes the caller to its log-loudly,
        // change-nothing branch (spec §17.1).
        return 'cancelled';
    }
  }
}
