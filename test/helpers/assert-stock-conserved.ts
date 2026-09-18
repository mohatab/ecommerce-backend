import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * The Phase 3 invariant (spec §5.1):
 *
 *   initialStock + sum(admin deltas)
 *     === currentStock + sum(quantity across PENDING orders)
 *
 * Stated as conservation rather than "stock >= 0" because the interesting
 * bugs — lost updates, double restoration, duplicated orders — all preserve
 * non-negativity while breaking conservation. Cancelled orders drop out of
 * the sum because their stock went back to the product.
 */
export async function assertStockConserved(
  prisma: PrismaService,
  productId: string,
  initialStock: number,
  adminDeltas = 0,
): Promise<void> {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    select: { stockQuantity: true },
  });

  const reserved = await prisma.orderItem.aggregate({
    where: { productId, order: { status: OrderStatus.PENDING } },
    _sum: { quantity: true },
  });

  const held = reserved._sum.quantity ?? 0;

  expect(product.stockQuantity + held).toBe(initialStock + adminDeltas);
  expect(product.stockQuantity).toBeGreaterThanOrEqual(0);
}
