import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { PrismaService } from '../src/prisma/prisma.service';

interface CategoryItem {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

interface ProductItem {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
  isActive: boolean;
  categoryId: string;
  category: CategoryItem;
  createdAt: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface PaginatedBody<T> {
  data: T[];
  meta: PaginationMeta;
}

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

describe('public catalog (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  describe('smoke', () => {
    it('lists active products without a token', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id, { name: 'Visible' });

      const response = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);

      const body = response.body as PaginatedBody<ProductItem>;

      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Visible');
      expect(body.meta.total).toBe(1);
    });

    it('excludes deactivated products from the public list', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id, { isActive: false });

      const response = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);

      expect((response.body as PaginatedBody<ProductItem>).data).toHaveLength(
        0,
      );
    });

    it('returns 404 for a deactivated product on the detail route', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        isActive: false,
      });

      await request(app.getHttpServer())
        .get(`/api/v1/products/${product.id}`)
        .expect(404);
    });

    it('lists categories without a token', async () => {
      await createCategory(prisma, { name: 'Desks', slug: 'desks' });

      const response = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .expect(200);

      expect((response.body as PaginatedBody<CategoryItem>).meta.total).toBe(1);
    });
  });

  describe('GET /api/v1/products/:id', () => {
    it('returns 200 with the joined category for an active product', async () => {
      const category = await createCategory(prisma, { name: 'Desks' });
      const product = await createProduct(prisma, category.id);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/products/${product.id}`)
        .expect(200);

      const body = response.body as ProductItem;

      expect(body.id).toBe(product.id);
      expect(body.category).toMatchObject({ id: category.id, name: 'Desks' });
    });

    it('returns 404 for a well-formed but unknown UUID', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/products/${randomUUID()}`)
        .expect(404);
    });
  });

  describe('response shape', () => {
    it('returns the mapped DTO only, with no updatedAt leak', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id);

      const response = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);

      const [item] = (response.body as PaginatedBody<ProductItem>).data;

      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'name',
          'description',
          'priceCents',
          'currency',
          'imageUrl',
          'isActive',
          'categoryId',
          'category',
          'createdAt',
        ].sort(),
      );
      expect(item).not.toHaveProperty('updatedAt');
    });

    it('never exposes a floating-point price, on the list or the detail route', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        priceCents: 4999,
      });

      const list = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);
      const [listItem] = (list.body as PaginatedBody<ProductItem>).data;
      expect(Number.isInteger(listItem.priceCents)).toBe(true);
      expect(listItem.priceCents).toBe(4999);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/products/${product.id}`)
        .expect(200);
      const detailBody = detail.body as ProductItem;
      expect(Number.isInteger(detailBody.priceCents)).toBe(true);
      expect(detailBody.priceCents).toBe(4999);
    });
  });

  describe('categories list', () => {
    it('returns rows in name asc order', async () => {
      await createCategory(prisma, { name: 'Banana', slug: 'banana' });
      await createCategory(prisma, { name: 'Apple', slug: 'apple' });
      await createCategory(prisma, { name: 'Cherry', slug: 'cherry' });

      const response = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .expect(200);

      const body = response.body as PaginatedBody<CategoryItem>;

      expect(body.data.map((c) => c.name)).toEqual([
        'Apple',
        'Banana',
        'Cherry',
      ]);
    });

    it('honours page and limit', async () => {
      await createCategory(prisma, { name: 'Banana', slug: 'banana' });
      await createCategory(prisma, { name: 'Apple', slug: 'apple' });
      await createCategory(prisma, { name: 'Cherry', slug: 'cherry' });

      const response = await request(app.getHttpServer())
        .get('/api/v1/categories?page=2&limit=2')
        .expect(200);

      const body = response.body as PaginatedBody<CategoryItem>;

      expect(body.data.map((c) => c.name)).toEqual(['Cherry']);
      expect(body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });
  });

  describe('products pagination', () => {
    it('returns the right slice and meta for page=2&limit=1', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id, {
        name: 'First',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      await createProduct(prisma, category.id, {
        name: 'Second',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });
      await createProduct(prisma, category.id, {
        name: 'Third',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      });

      // Default sort is createdAt desc, so page 1 is [Third, Second, First]
      // and page 2 with limit 1 is exactly [Second].
      const response = await request(app.getHttpServer())
        .get('/api/v1/products?page=2&limit=1')
        .expect(200);

      const body = response.body as PaginatedBody<ProductItem>;

      expect(body.data.map((p) => p.name)).toEqual(['Second']);
      expect(body.meta).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
    });

    it('reports correct metadata across pages, including a partial last page', async () => {
      const category = await createCategory(prisma);

      for (let i = 0; i < 25; i += 1) {
        await createProduct(prisma, category.id, { priceCents: 1000 + i });
      }

      const first = await request(app.getHttpServer())
        .get('/api/v1/products?page=1&limit=10')
        .expect(200);
      const firstBody = first.body as PaginatedBody<ProductItem>;

      expect(firstBody.meta).toEqual({
        page: 1,
        limit: 10,
        total: 25,
        totalPages: 3,
      });
      expect(firstBody.data).toHaveLength(10);

      const last = await request(app.getHttpServer())
        .get('/api/v1/products?page=3&limit=10')
        .expect(200);
      const lastBody = last.body as PaginatedBody<ProductItem>;

      expect(lastBody.data).toHaveLength(5);
      expect(lastBody.meta.page).toBe(3);
    });
  });

  describe('products sorting', () => {
    it('sorts by priceCents ascending when requested', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id, {
        name: 'High',
        priceCents: 900,
      });
      await createProduct(prisma, category.id, {
        name: 'Low',
        priceCents: 100,
      });
      await createProduct(prisma, category.id, {
        name: 'Mid',
        priceCents: 500,
      });

      const response = await request(app.getHttpServer())
        .get('/api/v1/products?sort=priceCents&order=asc')
        .expect(200);

      const body = response.body as PaginatedBody<ProductItem>;

      expect(body.data.map((p) => p.name)).toEqual(['Low', 'Mid', 'High']);
    });

    it('defaults to createdAt descending (newest first)', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id, {
        name: 'First',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      await createProduct(prisma, category.id, {
        name: 'Second',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });
      await createProduct(prisma, category.id, {
        name: 'Third',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      });

      const response = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);

      const body = response.body as PaginatedBody<ProductItem>;

      expect(body.data.map((p) => p.name)).toEqual([
        'Third',
        'Second',
        'First',
      ]);
    });
  });

  describe('products filters', () => {
    it('categoryId filters to that category only', async () => {
      const categoryA = await createCategory(prisma);
      const categoryB = await createCategory(prisma);
      await createProduct(prisma, categoryA.id, { name: 'In A' });
      await createProduct(prisma, categoryB.id, { name: 'In B' });

      const response = await request(app.getHttpServer())
        .get(`/api/v1/products?categoryId=${categoryA.id}`)
        .expect(200);

      const body = response.body as PaginatedBody<ProductItem>;

      expect(body.data.map((p) => p.name)).toEqual(['In A']);
    });

    it('minPriceCents/maxPriceCents window returns only products inside it', async () => {
      const category = await createCategory(prisma);
      await createProduct(prisma, category.id, {
        name: 'Cheap',
        priceCents: 100,
      });
      await createProduct(prisma, category.id, {
        name: 'InRange',
        priceCents: 500,
      });
      await createProduct(prisma, category.id, {
        name: 'Pricey',
        priceCents: 900,
      });

      const response = await request(app.getHttpServer())
        .get('/api/v1/products?minPriceCents=300&maxPriceCents=700')
        .expect(200);

      const body = response.body as PaginatedBody<ProductItem>;

      expect(body.data.map((p) => p.name)).toEqual(['InRange']);
    });
  });

  describe('query validation', () => {
    it('rejects an unknown query key with 400', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/products?bogus=1')
        .expect(400);
    });

    it('rejects an out-of-whitelist sort value with 400', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/products?sort=id')
        .expect(400);
    });

    it('rejects page=0 with 400', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/products?page=0')
        .expect(400);
    });

    it('rejects limit=101 with 400', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/products?limit=101')
        .expect(400);
    });

    it('rejects the admin-only status filter with 400', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/products?status=inactive')
        .expect(400);

      const body = response.body as ErrorBody;

      expect(Object.keys(body).sort()).toEqual(
        ['statusCode', 'message', 'error', 'timestamp', 'path'].sort(),
      );
      expect(body.statusCode).toBe(400);
    });
  });

  describe('auth remains enforced', () => {
    it('still returns 401 for a protected route without a token', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    });
  });

  describe('error shape', () => {
    it('returns the standard HttpExceptionFilter body on a 404', async () => {
      const unknownId = randomUUID();

      const response = await request(app.getHttpServer())
        .get(`/api/v1/products/${unknownId}`)
        .expect(404);

      const body = response.body as ErrorBody;

      expect(Object.keys(body).sort()).toEqual(
        ['statusCode', 'message', 'error', 'timestamp', 'path'].sort(),
      );
      expect(body.statusCode).toBe(404);
      expect(body.path).toBe(`/api/v1/products/${unknownId}`);
    });
  });
});
