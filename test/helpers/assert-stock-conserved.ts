import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * The Phase 3 invariant (spec §5.1):
 *
 *   initialStock + sum(admin deltas)
 *     === currentStock + sum(quantity across PENDING and PAID orders)
 *
 * Stated as conservation rather than "stock >= 0" because the interesting
 * bugs — lost updates, double restoration, duplicated orders — all preserve
 * non-negativity while breaking conservation. Cancelled orders drop out of
 * the sum because their stock went back to the product; PAID orders do not,
 * because a paid order's stock is never restored (Phase 4, spec §4.3).
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

  // PAID orders hold their stock exactly as PENDING ones do: checkout
  // decremented it and nothing ever restores it, because Phase 4 does not
  // cancel a paid order (spec §4.3). Only CANCELLED orders drop out of the
  // sum, because their stock went back to the product. Omitting PAID here
  // makes every paid-order test fail an invariant that is not broken.
  //
  // Phase 5: EXPIRED is likewise absent, and that is a decision, not an
  // omission. The expiry sweep restores every unit before it commits the
  // transition (spec §4.5), so an EXPIRED order holds nothing — including it
  // here would make every expiry look like an inventory leak, double-counting
  // units that are already back on the product row. The next OrderStatus
  // member needs the same deliberate call: does it hold its units, or has it
  // given them back?
  const reserved = await prisma.orderItem.aggregate({
    where: {
      productId,
      order: { status: { in: [OrderStatus.PENDING, OrderStatus.PAID] } },
    },
    _sum: { quantity: true },
  });

  const held = reserved._sum.quantity ?? 0;

  expect(product.stockQuantity + held).toBe(initialStock + adminDeltas);
  expect(product.stockQuantity).toBeGreaterThanOrEqual(0);
}
