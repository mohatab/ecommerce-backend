import { INestApplication } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { createOrder } from './factories/order.factory';

interface OrderListItem {
  id: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  cancelledAt: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    unitPriceCents: number;
    quantity: number;
    lineTotalCents: number;
  }>;
}

interface OrderListResponseBody {
  data: OrderListItem[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

describe('Orders (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    const user = await createUser(prisma);
    userId = user.id;
    token = await tokens.signAccessToken(user);
  });

  const auth = (): string => `Bearer ${token}`;

  it('returns an empty list with correct meta when the caller has no orders', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', auth())
      .expect(200);

    const body = response.body as OrderListResponseBody;
    expect(body.data).toEqual([]);
    expect(body.meta).toMatchObject({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  });

  it("lists only the caller's orders, newest first", async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const stranger = await createUser(prisma);

    const first = await createOrder(prisma, userId, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 1,
      },
    ]);
    const second = await createOrder(prisma, userId, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 2,
      },
    ]);
    await createOrder(prisma, stranger.id, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 1,
      },
    ]);

    const response = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', auth())
      .expect(200);

    const body = response.body as OrderListResponseBody;
    expect(body.meta.total).toBe(2);
    expect(body.data.map((order) => order.id)).toEqual([second.id, first.id]);
    expect(body.data[0].items[0].lineTotalCents).toBe(product.priceCents * 2);
  });

  it('paginates', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    for (let index = 0; index < 3; index += 1) {
      await createOrder(prisma, userId, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 1,
        },
      ]);
    }

    const response = await request(app.getHttpServer())
      .get('/api/v1/orders?page=2&limit=2')
      .set('Authorization', auth())
      .expect(200);

    const body = response.body as OrderListResponseBody;
    expect(body.data).toHaveLength(1);
    expect(body.meta).toMatchObject({
      page: 2,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
  });

  it("404s on another user's order, and 401s without a token", async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const stranger = await createUser(prisma);
    const theirs = await createOrder(prisma, stranger.id, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 1,
      },
    ]);

    await request(app.getHttpServer())
      .get(`/api/v1/orders/${theirs.id}`)
      .set('Authorization', auth())
      .expect(404);

    await request(app.getHttpServer())
      .get(`/api/v1/orders/${theirs.id}`)
      .expect(401);
  });

  it('returns the full response shape for a single order, without idempotencyKey', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const order = await createOrder(prisma, userId, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 2,
      },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', auth())
      .expect(200);

    const body = response.body as OrderListItem;
    expect(body).toMatchObject({
      id: order.id,
      status: OrderStatus.PENDING,
      totalCents: product.priceCents * 2,
      currency: 'USD',
      cancelledAt: null,
    });
    expect(body.createdAt).toBeDefined();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      productId: product.id,
      productName: product.name,
      unitPriceCents: product.priceCents,
      quantity: 2,
      lineTotalCents: product.priceCents * 2,
    });
    expect(body).not.toHaveProperty('idempotencyKey');
  });

  it('computes lineTotalCents as unitPriceCents times quantity', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const order = await createOrder(prisma, userId, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 3,
      },
    ]);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', auth())
      .expect(200);

    const body = response.body as OrderListItem;
    expect(body.items[0].lineTotalCents).toBe(product.priceCents * 3);
  });

  it('shows the OrderItem snapshot, not a live Product lookup, after the product changes', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      name: 'Original Name',
      priceCents: 1000,
    });
    const order = await createOrder(prisma, userId, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 2,
      },
    ]);

    await prisma.product.update({
      where: { id: product.id },
      data: { name: 'Renamed Product', priceCents: 9999 },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', auth())
      .expect(200);

    const body = response.body as OrderListItem;
    expect(body.items[0].productName).toBe('Original Name');
    expect(body.items[0].unitPriceCents).toBe(1000);
    expect(body.items[0].lineTotalCents).toBe(2000);
    expect(body.totalCents).toBe(2000);
  });
});
