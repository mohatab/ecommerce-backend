import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { CartItem, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductsService } from '../products/products.service';

/** One cart may hold at most this many distinct products. */
const MAX_CART_LINES = 50;

export type CartWithItems = Prisma.CartGetPayload<{
  include: { items: { include: { product: { include: { category: true } } } } };
}>;

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
  ) {}

  /**
   * Takes this user's cart row lock, creating the cart if it is the first
   * one. The `update` branch is what acquires the lock, held until commit:
   * every cart mutation and every checkout starts here, which is what stops
   * two concurrent checkouts from both consuming the same cart.
   *
   * The upsert also removes the first-cart creation race; Prisma compiles
   * this shape (single unique field, no nested writes) to a native
   * INSERT ... ON CONFLICT. Test C8 proves that rather than trusting it.
   */
  async lockForUpdate(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ id: string }> {
    return tx.cart.upsert({
      where: { userId },
      create: { userId },
      update: { updatedAt: new Date() },
      select: { id: true },
    });
  }

  /** Sorted by productId so every caller takes product locks in one order. */
  async listItemsForCheckout(
    tx: Prisma.TransactionClient,
    cartId: string,
  ): Promise<CartItem[]> {
    return tx.cartItem.findMany({
      where: { cartId },
      orderBy: { productId: 'asc' },
    });
  }

  async clear(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
    await tx.cartItem.deleteMany({ where: { cartId } });
  }

  /** Never creates a cart: a read must not write. */
  async getForUser(userId: string): Promise<CartWithItems | null> {
    return this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: { product: { include: { category: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /**
   * SETS the quantity for one product (D11). Repeated calls are idempotent;
   * there is no increment path, so two of the user's own tabs cannot produce
   * a lost update.
   */
  async setItem(
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CartWithItems> {
    // 404s for unknown or inactive. Deliberately outside the lock: this is a
    // convenience check, and checkout's decrement predicate is the authority
    // if the product is deactivated in between.
    await this.productsService.findOne(productId, 'active-only');

    await this.prisma.$transaction(async (tx) => {
      const cart = await this.lockForUpdate(tx, userId);

      const existing = await tx.cartItem.findUnique({
        where: { cartId_productId: { cartId: cart.id, productId } },
        select: { id: true },
      });

      if (!existing) {
        const lines = await tx.cartItem.count({ where: { cartId: cart.id } });

        if (lines >= MAX_CART_LINES) {
          throw new UnprocessableEntityException(
            `A cart may hold at most ${MAX_CART_LINES} products`,
          );
        }
      }

      await tx.cartItem.upsert({
        where: { cartId_productId: { cartId: cart.id, productId } },
        create: { cartId: cart.id, productId, quantity },
        update: { quantity },
      });
    });

    const cart = await this.getForUser(userId);

    // Unreachable: the transaction above created the cart if needed.
    if (!cart) {
      throw new UnprocessableEntityException('Cart could not be read');
    }

    return cart;
  }

  /** Idempotent: removing an absent line, or acting on a user with no cart,
   *  is a no-op rather than a 404. */
  async removeItem(userId: string, productId: string): Promise<void> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!cart) {
      return;
    }

    await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id, productId },
    });
  }
}
