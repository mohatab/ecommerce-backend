import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsService } from '../src/modules/products/products.service';
import {
  ProductListQueryDto,
  ProductSortField,
  SortOrder,
} from '../src/modules/products/dto/product-list-query.dto';
import { truncateAll } from './helpers/truncate';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';

describe('ProductsService (e2e)', () => {
  let prisma: PrismaService;
  let service: ProductsService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ProductsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const query = (
    overrides: Partial<ProductListQueryDto> = {},
  ): ProductListQueryDto => Object.assign(new ProductListQueryDto(), overrides);

  const expectRejectsWith = async (
    promise: Promise<unknown>,
    code: string,
  ): Promise<void> => {
    try {
      await promise;
      throw new Error('expected the promise to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(code);
    }
  };

  describe('visibility boundary', () => {
    it('active-only excludes inactive products', async () => {
      const category = await createCategory(prisma);
      const active = await createProduct(prisma, category.id, {
        isActive: true,
      });
      await createProduct(prisma, category.id, { isActive: false });

      const result = await service.list(query(), 'active-only');

      expect(result.items.map((p) => p.id)).toEqual([active.id]);
      expect(result.total).toBe(1);
    });

    it('inactive-only excludes active products', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id, { isActive: true });
      const inactive = await createProduct(prisma, category.id, {
        isActive: false,
      });

      const result = await service.list(query(), 'inactive-only');

      expect(result.items.map((p) => p.id)).toEqual([inactive.id]);
      expect(result.total).toBe(1);
    });

    it('all returns both active and inactive products', async () => {
      const category = await createCategory(prisma);
      const active = await createProduct(prisma, category.id, {
        isActive: true,
      });
      const inactive = await createProduct(prisma, category.id, {
        isActive: false,
      });

      const result = await service.list(query(), 'all');

      expect(result.items.map((p) => p.id).sort()).toEqual(
        [active.id, inactive.id].sort(),
      );
      expect(result.total).toBe(2);
    });

    it('findOne succeeds for an active product under active-only', async () => {
      const category = await createCategory(prisma);
      const active = await createProduct(prisma, category.id, {
        isActive: true,
      });

      const found = await service.findOne(active.id, 'active-only');

      expect(found.id).toBe(active.id);
    });

    it('findOne throws NotFoundException for an inactive product under active-only', async () => {
      const category = await createCategory(prisma);
      const inactive = await createProduct(prisma, category.id, {
        isActive: false,
      });

      await expect(
        service.findOne(inactive.id, 'active-only'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('findOne succeeds for an inactive product under inactive-only', async () => {
      const category = await createCategory(prisma);
      const inactive = await createProduct(prisma, category.id, {
        isActive: false,
      });

      const found = await service.findOne(inactive.id, 'inactive-only');

      expect(found.id).toBe(inactive.id);
    });
  });

  describe('category relation', () => {
    it('populates category on every returned product', async () => {
      const category = await createCategory(prisma, { name: 'Desks' });
      await createProduct(prisma, category.id);

      const result = await service.list(query(), 'active-only');

      expect(result.items[0].category).toMatchObject({
        id: category.id,
        name: 'Desks',
      });
    });

    it('creates a product and returns it with its category joined', async () => {
      const category = await createCategory(prisma, { name: 'Desks' });

      const created = await service.create({
        name: 'Standing Desk',
        description: 'Adjustable height',
        priceCents: 29999,
        currency: 'USD',
        categoryId: category.id,
      });

      expect(created.category).toMatchObject({
        id: category.id,
        name: 'Desks',
      });
      expect(created.priceCents).toBe(29999);
      expect(created.currency).toBe('USD');
      expect(created.isActive).toBe(true);

      const persisted = await prisma.product.findUnique({
        where: { id: created.id },
      });
      expect(persisted).not.toBeNull();
      expect(persisted?.name).toBe('Standing Desk');
    });

    it('rejects create with an unknown categoryId as P2003', async () => {
      await expectRejectsWith(
        service.create({
          name: 'Orphan',
          description: 'No category',
          priceCents: 1000,
          currency: 'USD',
          categoryId: '00000000-0000-0000-0000-000000000000',
        }),
        'P2003',
      );
    });
  });

  describe('update semantics', () => {
    it('changes only the supplied field, leaving the rest intact', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        name: 'Desk Lamp',
        description: 'A lamp',
        priceCents: 4999,
        currency: 'USD',
        categoryId: category.id,
      });

      const updated = await service.update(product.id, {
        priceCents: 5999,
      });

      expect(updated.priceCents).toBe(5999);
      expect(updated.name).toBe('Desk Lamp');
      expect(updated.description).toBe('A lamp');
      expect(updated.currency).toBe('USD');
      expect(updated.categoryId).toBe(category.id);
    });

    it('rejects update on an unknown id with P2025', async () => {
      await expectRejectsWith(
        service.update('00000000-0000-0000-0000-000000000000', {
          name: 'Nope',
        }),
        'P2025',
      );
    });

    it('reactivation via update restores a product to the active-only list', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        isActive: false,
      });

      await service.update(product.id, { isActive: true });

      const result = await service.list(query(), 'active-only');
      expect(result.items.map((p) => p.id)).toContain(product.id);
    });
  });

  describe('deactivate', () => {
    it('is a soft delete: the row still exists with isActive false', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        isActive: true,
      });

      await service.deactivate(product.id);

      const row = await prisma.product.findUnique({
        where: { id: product.id },
      });
      expect(row).not.toBeNull();
      expect(row?.isActive).toBe(false);
    });
  });

  describe('schema contract', () => {
    it('round-trips priceCents as an integer', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        priceCents: 12345,
      });

      const found = await service.findOne(product.id, 'active-only');

      expect(Number.isInteger(found.priceCents)).toBe(true);
      expect(found.priceCents).toBe(12345);
    });

    it('the schema defaults currency to USD when the column is omitted', async () => {
      // CreateProductInput.currency is required by the brief's contract, so
      // the service can never omit it — the default lives in the schema, and
      // going through prisma.product.create directly is the only way to
      // exercise it.
      const category = await createCategory(prisma);

      const created = await prisma.product.create({
        data: {
          name: 'No Currency Given',
          description: 'desc',
          priceCents: 1000,
          categoryId: category.id,
        },
      });

      expect(created.currency).toBe('USD');
    });

    it('leaves imageUrl null when omitted and readable back when set', async () => {
      const category = await createCategory(prisma);

      const withoutImage = await createProduct(prisma, category.id);
      expect(withoutImage.imageUrl).toBeNull();

      const withImage = await service.update(withoutImage.id, {
        imageUrl: 'https://example.com/lamp.png',
      });
      expect(withImage.imageUrl).toBe('https://example.com/lamp.png');
    });
  });

  describe('filters and sort against real rows', () => {
    it('categoryId filter returns only that category products', async () => {
      const categoryA = await createCategory(prisma);
      const categoryB = await createCategory(prisma);
      const inA = await createProduct(prisma, categoryA.id);
      await createProduct(prisma, categoryB.id);

      const result = await service.list(
        query({ categoryId: categoryA.id }),
        'active-only',
      );

      expect(result.items.map((p) => p.id)).toEqual([inA.id]);
      expect(result.total).toBe(1);
    });

    it('minPriceCents/maxPriceCents window returns only products inside it', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id, { priceCents: 100 });
      const inRange = await createProduct(prisma, category.id, {
        priceCents: 500,
      });
      await createProduct(prisma, category.id, { priceCents: 900 });

      const result = await service.list(
        query({ minPriceCents: 300, maxPriceCents: 700 }),
        'active-only',
      );

      expect(result.items.map((p) => p.id)).toEqual([inRange.id]);
    });

    it('sorts by priceCents ascending', async () => {
      const category = await createCategory(prisma);
      const high = await createProduct(prisma, category.id, {
        priceCents: 900,
      });
      const low = await createProduct(prisma, category.id, {
        priceCents: 100,
      });
      const mid = await createProduct(prisma, category.id, {
        priceCents: 500,
      });

      const result = await service.list(
        query({ sort: ProductSortField.PriceCents, order: SortOrder.Asc }),
        'active-only',
      );

      expect(result.items.map((p) => p.id)).toEqual([low.id, mid.id, high.id]);
    });

    it('defaults to newest-first by createdAt', async () => {
      // Explicit, distinct createdAt values rather than relying on real-clock
      // ordering across sequential inserts: createdAt has @default(now()) in
      // the schema, but it is a plain writable column, so an explicit value
      // passed through the factory's overrides takes precedence over the
      // default and makes this deterministic regardless of DB clock
      // resolution.
      const category = await createCategory(prisma);
      const first = await createProduct(prisma, category.id, {
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const second = await createProduct(prisma, category.id, {
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });
      const third = await createProduct(prisma, category.id, {
        createdAt: new Date('2026-01-03T00:00:00Z'),
      });

      const result = await service.list(query(), 'active-only');

      expect(result.items.map((p) => p.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
    });
  });
});
