import { Cart, CartItem } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Inserts through the Prisma client, never $executeRaw: ids use
 * `@default(uuid(7))`, which Prisma generates client-side, so a raw insert
 * would produce a row with no id.
 */
export async function createCart(
  prisma: PrismaService,
  userId: string,
): Promise<Cart> {
  return prisma.cart.create({ data: { userId } });
}

export async function createCartItem(
  prisma: PrismaService,
  cartId: string,
  productId: string,
  quantity = 1,
): Promise<CartItem> {
  return prisma.cartItem.create({ data: { cartId, productId, quantity } });
}
