import { Category, Product } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './helpers/truncate';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';

describe('catalog factories', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  it('creates a category', async () => {
    const category = await createCategory(prisma);

    const found = await prisma.category.findUnique({
      where: { id: category.id },
    });

    expect(found).not.toBeNull();
    expect(typeof category.id).toBe('string');
    expect(category.id.length).toBeGreaterThan(0);
    expect(category.name).toBeTruthy();
    expect(category.slug).toBeTruthy();
  });

  it('creates a product with a valid category', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    const found = await prisma.product.findUnique({
      where: { id: product.id },
    });

    expect(found).not.toBeNull();
    expect(product.categoryId).toBe(category.id);
    expect(Number.isInteger(product.priceCents)).toBe(true);
    expect(product.currency).toBe('USD');
    expect(product.isActive).toBe(true);
  });

  it('applies overrides on top of the defaults for both factories', async () => {
    const category = await createCategory(prisma, { name: 'Custom' });
    expect(category.name).toBe('Custom');

    const product = await createProduct(prisma, category.id, {
      isActive: false,
    });
    expect(product.isActive).toBe(false);
  });

  it('creates multiple categories and products without unique-constraint errors', async () => {
    const categories: Category[] = [];
    for (let i = 0; i < 3; i += 1) {
      categories.push(await createCategory(prisma));
    }

    const products: Product[] = [];
    for (const category of categories) {
      products.push(await createProduct(prisma, category.id));
      products.push(await createProduct(prisma, category.id));
    }

    expect(products).toHaveLength(6);

    const names = new Set(categories.map((category) => category.name));
    const slugs = new Set(categories.map((category) => category.slug));
    expect(names.size).toBe(categories.length);
    expect(slugs.size).toBe(categories.length);
  });
});
