import { Category, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Safe ONLY because the e2e suite is serial (`maxWorkers: 1` in
 * test/jest-e2e.json). Do not reuse this pattern if per-worker isolation is
 * ever added — parallel workers would hand out colliding names and slugs.
 *
 * Resets to 0 for every spec file, because Jest gives each file its own module
 * registry. `categories.name` and `categories.slug` are both @unique, so a
 * suite that creates fixed fixtures without truncating first will collide with
 * P2002. Suites using this factory should call `truncateAll()` in `beforeEach`.
 */
let sequence = 0;

export async function createCategory(
  prisma: PrismaService,
  overrides: Partial<Prisma.CategoryCreateInput> = {},
): Promise<Category> {
  sequence += 1;

  return prisma.category.create({
    data: {
      name: `Category ${sequence}`,
      slug: `category-${sequence}`,
      ...overrides,
    },
  });
}
