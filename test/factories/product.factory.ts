import { Prisma, Product } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Same serial-suite caveat as the category factory. */
let sequence = 0;

/**
 * `categoryId` is a required positional argument rather than an override,
 * because Product.categoryId is required and a product with a dangling
 * category raises P2003. Callers create a category first.
 *
 * Inserts through the Prisma client, never $executeRaw: ids use
 * `@default(uuid(7))`, which Prisma generates client-side, so a raw insert
 * would produce a row with no id.
 */
export async function createProduct(
  prisma: PrismaService,
  categoryId: string,
  overrides: Partial<Prisma.ProductUncheckedCreateInput> = {},
): Promise<Product> {
  sequence += 1;

  return prisma.product.create({
    data: {
      name: `Product ${sequence}`,
      description: `Description for product ${sequence}`,
      // Integer minor units, always. Never a decimal literal here.
      priceCents: 1000 + sequence,
      currency: 'USD',
      // Phase 3: factory products are sellable by default. Tests that care
      // about stock pass an explicit override.
      stockQuantity: 100,
      isActive: true,
      categoryId,
      ...overrides,
    },
  });
}
