import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { ProductsService } from '../products/products.service';
import { OrderWithItems } from './dto/order-response.dto';

/** Postgres INT upper bound; totalCents is an INT column. */
const MAX_TOTAL_CENTS = 2_147_483_647;

// Prisma's defaults (2s / 5s) are tight for a body that waits on row locks
// while holding a pooled connection. Exceeding these raises P2028, which is
// deliberately unmapped: a logged 500 is the right signal for saturation.
const TX_MAX_WAIT_MS = 5_000;
const TX_TIMEOUT_MS = 10_000;

const UNAVAILABLE_MESSAGE = 'Product is no longer available';
const INSUFFICIENT_STOCK_MESSAGE = 'Insufficient stock';

export interface CheckoutResult {
  order: OrderWithItems;
  replayed: boolean;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cartService: CartService,
    private readonly productsService: ProductsService,
  ) {}

  /**
   * One transaction, in this order, for reasons recorded in spec §5.5:
   *
   *  1. lock the cart row       — serialises this user's checkouts
   *  2. look up the key         — INSIDE the lock, so a concurrent duplicate
   *                               sees the committed order instead of an
   *                               empty cart
   *  3. decrement stock         — sorted by productId; the predicate travels
   *                               with the write
   *  4. snapshot prices         — AFTER the locks are held
   *  5. create the order, clear the cart
   *
   * NO external I/O may ever be added inside this transaction: no HTTP call,
   * no token signing, no argon2. Phase 4's payment call happens after commit.
   */
  async checkout(
    userId: string,
    idempotencyKey: string,
  ): Promise<CheckoutResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const cart = await this.cartService.lockForUpdate(tx, userId);

        const existing = await tx.order.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
          include: { items: true },
        });

        if (existing) {
          return { order: existing, replayed: true };
        }

        const items = await this.cartService.listItemsForCheckout(tx, cart.id);

        if (items.length === 0) {
          throw new ConflictException('Cart is empty');
        }

        // CartService.listItemsForCheckout already sorts by productId, but
        // the decrement order is a load-bearing invariant (every caller must
        // take product locks in the same order, or two concurrent checkouts
        // sharing a product pair can deadlock instead of one waiting for the
        // other). Sorting again here makes that guarantee independent of the
        // caller rather than trusting it silently.
        const sortedItems = [...items].sort((a, b) =>
          a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
        );

        // ponytail: checkouts of the same product serialise on its row lock,
        // so single-SKU throughput is bounded by lock hold time (~10-20ms).
        // Upgrade path is a reservation queue, only if measurement shows the
        // need.
        for (const item of sortedItems) {
          const count = await this.productsService.decrementStock(
            tx,
            item.productId,
            item.quantity,
          );

          if (count === 0) {
            throw await this.refusalFor(tx, item.productId);
          }
        }

        const snapshots = await this.productsService.findManyForSnapshot(
          tx,
          sortedItems.map((item) => item.productId),
        );
        const byId = new Map(
          snapshots.map((snapshot) => [snapshot.id, snapshot]),
        );

        const currencies = new Set(
          snapshots.map((snapshot) => snapshot.currency),
        );

        if (currencies.size > 1) {
          throw new UnprocessableEntityException(
            'Cart contains products in more than one currency',
          );
        }

        let totalCents = 0;
        const lines = sortedItems.map((item) => {
          // Non-null: the decrement above matched this product's row.
          const product = byId.get(item.productId)!;

          totalCents += product.priceCents * item.quantity;

          return {
            productId: product.id,
            productName: product.name,
            unitPriceCents: product.priceCents,
            quantity: item.quantity,
          };
        });

        if (totalCents > MAX_TOTAL_CENTS) {
          throw new UnprocessableEntityException(
            'Order total exceeds the supported maximum',
          );
        }

        const order = await tx.order.create({
          data: {
            userId,
            idempotencyKey,
            totalCents,
            currency: [...currencies][0],
            items: { create: lines },
          },
          include: { items: true },
        });

        await this.cartService.clear(tx, cart.id);

        return { order, replayed: false };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: TX_MAX_WAIT_MS,
        timeout: TX_TIMEOUT_MS,
      },
    );
  }

  /** 'missing' and 'inactive' share one client message; only the logs differ. */
  private async refusalFor(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<ConflictException> {
    const refusal = await this.productsService.describeRefusal(tx, productId);

    if (refusal === 'missing') {
      this.logger.warn(
        `Cart referenced product ${productId}, which no longer exists`,
      );
    }

    return new ConflictException(
      refusal === 'insufficient-stock'
        ? INSUFFICIENT_STOCK_MESSAGE
        : UNAVAILABLE_MESSAGE,
    );
  }
}
