import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser, TEST_PASSWORD } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { PrismaService } from '../src/prisma/prisma.service';

interface AuthBody {
  accessToken: string;
}

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

describe('admin products (e2e)', () => {
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

  const login = async (email: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

    return (response.body as AuthBody).accessToken;
  };

  const adminToken = async (): Promise<string> => {
    const admin = await createUser(prisma, { role: Role.ADMIN });
    return login(admin.email);
  };

  const customerToken = async (): Promise<string> => {
    const customer = await createUser(prisma, { role: Role.CUSTOMER });
    return login(customer.email);
  };

  describe('POST /api/v1/admin/products', () => {
    const body = (categoryId: string): Record<string, unknown> => ({
      name: 'Desk Lamp',
      description: 'An adjustable desk lamp.',
      priceCents: 4999,
      categoryId,
    });

    it('returns 401 without a token', async () => {
      const category = await createCategory(prisma);

      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .send(body(category.id))
        .expect(401);
    });

    it('returns 403 for a CUSTOMER token', async () => {
      const category = await createCategory(prisma);
      const token = await customerToken();

      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send(body(category.id))
        .expect(403);
    });

    it('returns 201 with the created product for an ADMIN', async () => {
      const category = await createCategory(prisma, { name: 'Desks' });
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send(body(category.id))
        .expect(201);

      const created = response.body as ProductItem;

      expect(created.category.id).toBe(category.id);
      expect(created.category.name).toBe('Desks');
      expect(Number.isInteger(created.priceCents)).toBe(true);
      expect(created.priceCents).toBe(4999);
      expect(created.isActive).toBe(true);
    });

    it('returns 409 for a well-formed but unknown categoryId', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send(body(randomUUID()))
        .expect(409);
    });

    it('returns 400 for an unexpected extra field', async () => {
      const category = await createCategory(prisma);
      const token = await adminToken();

      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body(category.id), bogus: 1 })
        .expect(400);
    });

    it('returns 400 for a non-integer priceCents', async () => {
      const category = await createCategory(prisma);
      const token = await adminToken();

      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body(category.id), priceCents: 49.99 })
        .expect(400);
    });
  });

  describe('PATCH /api/v1/admin/products/:id', () => {
    it('returns 401 without a token', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .send({ priceCents: 100 })
        .expect(401);
    });

    it('returns 403 for a CUSTOMER token', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const token = await customerToken();

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priceCents: 100 })
        .expect(403);
    });

    it('applies a partial update and preserves unspecified fields', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        name: 'Original Name',
        description: 'Original description.',
        currency: 'USD',
      });
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priceCents: 7777 })
        .expect(200);

      const updated = response.body as ProductItem;

      expect(updated.priceCents).toBe(7777);
      expect(updated.name).toBe('Original Name');
      expect(updated.description).toBe('Original description.');
      expect(updated.currency).toBe('USD');
      expect(updated.categoryId).toBe(category.id);
    });

    it('returns 404 for a well-formed but unknown UUID', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${randomUUID()}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priceCents: 100 })
        .expect(404);
    });

    it('reactivates a deactivated product, which reappears in the public list', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        isActive: false,
      });
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: true })
        .expect(200);

      expect((response.body as ProductItem).isActive).toBe(true);

      const listResponse = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);

      const ids = (listResponse.body as PaginatedBody<ProductItem>).data.map(
        (item) => item.id,
      );
      expect(ids).toContain(product.id);
    });
  });

  describe('DELETE /api/v1/admin/products/:id', () => {
    it('returns 401 without a token', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${product.id}`)
        .expect(401);
    });

    it('returns 403 for a CUSTOMER token', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const token = await customerToken();

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('returns 204 with an empty body for an ADMIN', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      expect(response.body).toEqual({});
    });

    it('returns 404 for a well-formed but unknown UUID', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${randomUUID()}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('soft-deletes: the row survives with isActive false, and 404s publicly', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const token = await adminToken();

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const row = await prisma.product.findUnique({
        where: { id: product.id },
      });
      expect(row).not.toBeNull();
      expect(row?.isActive).toBe(false);

      await request(app.getHttpServer())
        .get(`/api/v1/products/${product.id}`)
        .expect(404);
    });
  });

  describe('error shape', () => {
    it('returns the standard HttpExceptionFilter body on a 403', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const token = await customerToken();

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priceCents: 100 })
        .expect(403);

      const body = response.body as ErrorBody;

      expect(Object.keys(body).sort()).toEqual(
        ['statusCode', 'message', 'error', 'timestamp', 'path'].sort(),
      );
      expect(body.statusCode).toBe(403);
      expect(body.path).toBe(`/api/v1/admin/products/${product.id}`);
    });
  });
});
