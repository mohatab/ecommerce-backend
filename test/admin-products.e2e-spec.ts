import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
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
  stockQuantity: number;
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

  // Ruling 32: the dangerous invalid token on an admin route is not
  // `Bearer not-a-jwt` (Phase 1's auth-guard suite already pins that on
  // /auth/me) — it is a well-formed token forging the exact claim shape
  // RolesGuard reads. Signing with the real secret (the control) proves the
  // 401 above comes from the signature alone.
  const claimToken = (userId: string, secret: string): string =>
    new JwtService().sign(
      { sub: userId, role: Role.ADMIN },
      { secret, algorithm: 'HS256' },
    );

  const realJwtSecret = (): string => {
    const secret = app.get(ConfigService).get<string>('jwt.secret');
    if (!secret) {
      throw new Error('jwt.secret is not configured for the test app');
    }
    return secret;
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

    it('persists a supplied stockQuantity instead of the 0 default', async () => {
      const category = await createCategory(prisma);
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body(category.id), stockQuantity: 7 })
        .expect(201);

      const created = response.body as ProductItem;
      expect(created.stockQuantity).toBe(7);

      // Read it back through the public catalog too, so the assertion covers
      // what was stored and not just what the create handler echoed.
      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/products/${created.id}`)
        .expect(200);
      expect((fetched.body as ProductItem).stockQuantity).toBe(7);
    });

    it('defaults stockQuantity to 0 when it is omitted', async () => {
      const category = await createCategory(prisma);
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send(body(category.id))
        .expect(201);

      expect((response.body as ProductItem).stockQuantity).toBe(0);
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

    it('returns 401 for a forged ADMIN token signed with the wrong secret, and creates nothing', async () => {
      const category = await createCategory(prisma);
      const admin = await createUser(prisma, { role: Role.ADMIN });
      const forged = claimToken(admin.id, 'not-the-real-secret');

      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${forged}`)
        .send(body(category.id))
        .expect(401);

      const count = await prisma.product.count();
      expect(count).toBe(0);
    });

    it('control: the identical payload signed with the real secret succeeds', async () => {
      const category = await createCategory(prisma);
      const admin = await createUser(prisma, { role: Role.ADMIN });
      const control = claimToken(admin.id, realJwtSecret());

      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${control}`)
        .send(body(category.id))
        .expect(201);

      const count = await prisma.product.count();
      expect(count).toBe(1);
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

    it('returns 409 for an unknown categoryId, leaving the product unchanged', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const token = await adminToken();

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryId: randomUUID() })
        .expect(409);

      const row = await prisma.product.findUnique({
        where: { id: product.id },
      });
      expect(row?.categoryId).toBe(category.id);
    });

    it('returns 401 for a forged ADMIN token signed with the wrong secret, and leaves the product unchanged', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        name: 'Original Name',
      });
      const admin = await createUser(prisma, { role: Role.ADMIN });
      const forged = claimToken(admin.id, 'not-the-real-secret');

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${forged}`)
        .send({ name: 'Forged Update' })
        .expect(401);

      const row = await prisma.product.findUnique({
        where: { id: product.id },
      });
      expect(row?.name).toBe('Original Name');
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

    it('returns 401 for a forged ADMIN token signed with the wrong secret, and does not deactivate the product', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const admin = await createUser(prisma, { role: Role.ADMIN });
      const forged = claimToken(admin.id, 'not-the-real-secret');

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);

      const row = await prisma.product.findUnique({
        where: { id: product.id },
      });
      expect(row?.isActive).toBe(true);
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

  describe('cross-feature lifecycle', () => {
    it('walks create, publish, deactivate, and restore entirely through HTTP', async () => {
      const category = await createCategory(prisma);
      const token = await adminToken();

      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Lifecycle Lamp',
          description: 'Created through the admin API.',
          priceCents: 4999,
          categoryId: category.id,
        })
        .expect(201);

      const productId = (created.body as ProductItem).id;

      const listAfterCreate = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);
      const afterCreate = listAfterCreate.body as PaginatedBody<ProductItem>;
      expect(afterCreate.data.map((p) => p.id)).toContain(productId);
      const totalAfterCreate = afterCreate.meta.total;

      await request(app.getHttpServer())
        .get(`/api/v1/products/${productId}`)
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/products/${productId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const listAfterDelete = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);
      const afterDelete = listAfterDelete.body as PaginatedBody<ProductItem>;
      expect(afterDelete.data.map((p) => p.id)).not.toContain(productId);
      expect(afterDelete.meta.total).toBe(totalAfterCreate - 1);

      await request(app.getHttpServer())
        .get(`/api/v1/products/${productId}`)
        .expect(404);

      const rowAfterDelete = await prisma.product.findUnique({
        where: { id: productId },
      });
      expect(rowAfterDelete).not.toBeNull();
      expect(rowAfterDelete?.isActive).toBe(false);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${productId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: true })
        .expect(200);

      const listAfterRestore = await request(app.getHttpServer())
        .get('/api/v1/products')
        .expect(200);
      const afterRestore = listAfterRestore.body as PaginatedBody<ProductItem>;
      expect(afterRestore.data.map((p) => p.id)).toContain(productId);

      await request(app.getHttpServer())
        .get(`/api/v1/products/${productId}`)
        .expect(200);
    });
  });

  describe('POST /api/v1/admin/products/:id/stock-adjustments', () => {
    it('restocks relatively and returns the new level', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 5,
      });
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: 7 })
        .expect(200);

      expect((response.body as ProductItem).stockQuantity).toBe(12);
    });

    it('removes stock with a negative delta', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 5,
      });
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: -5 })
        .expect(200);

      expect((response.body as ProductItem).stockQuantity).toBe(0);
    });

    it('409s rather than letting stock go negative', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 3,
      });
      const token = await adminToken();

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: -4 })
        .expect(409);

      const unchanged = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(unchanged.stockQuantity).toBe(3);
    });

    it('restocks an inactive product', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 0,
        isActive: false,
      });
      const token = await adminToken();

      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: 4 })
        .expect(200);

      const body = response.body as ProductItem;
      expect(body.stockQuantity).toBe(4);
      expect(body.isActive).toBe(false);
    });

    it('400s on a zero or non-integer delta', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const token = await adminToken();

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: 0 })
        .expect(400);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: 1.5 })
        .expect(400);
    });

    it('404s for an unknown product', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .post(
          '/api/v1/admin/products/0195f0a0-0000-7000-8000-0000000000ff/stock-adjustments',
        )
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: 1 })
        .expect(404);
    });

    it('403s for a customer and 401s without a token', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const token = await customerToken();

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: 1 })
        .expect(403);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .send({ delta: 1 })
        .expect(401);
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
