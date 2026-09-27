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
import { assertStockConserved } from './helpers/assert-stock-conserved';
import { OrdersService } from '../src/modules/orders/orders.service';

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

    // createdAt is pinned rather than relying on wall-clock gaps: the column
    // is TIMESTAMP(3), so two back-to-back inserts can share a millisecond
    // and "newest first" would otherwise be a timing coin-flip.
    const first = await createOrder(
      prisma,
      userId,
      [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 1,
        },
      ],
      { createdAt: new Date('2026-09-16T10:00:00.000Z') },
    );
    const second = await createOrder(
      prisma,
      userId,
      [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 2,
        },
      ],
      { createdAt: new Date('2026-09-16T11:00:00.000Z') },
    );
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

  it('breaks a same-millisecond createdAt tie by id, descending', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const sameInstant = new Date('2026-09-16T12:00:00.000Z');

    const line = {
      productId: product.id,
      productName: product.name,
      unitPriceCents: product.priceCents,
      quantity: 1,
    };
    const a = await createOrder(prisma, userId, [line], {
      createdAt: sameInstant,
    });
    const b = await createOrder(prisma, userId, [line], {
      createdAt: sameInstant,
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', auth())
      .expect(200);

    const body = response.body as OrderListResponseBody;
    // With createdAt tied, the id tiebreaker is the only thing making this
    // deterministic: without it Postgres may return either order.
    expect(body.data.map((order) => order.id)).toEqual(
      [a.id, b.id].sort().reverse(),
    );
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

  describe('cancelling a non-pending order', () => {
    it('returns 409 on a PAID order and restores no stock', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 10,
      });
      const order = await createOrder(prisma, userId, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 2,
        },
      ]);

      // The factory does not decrement stock, so mirror checkout by hand:
      // conservation is asserted against 8 held-by-order units below.
      await prisma.product.update({
        where: { id: product.id },
        data: { stockQuantity: 8 },
      });
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.PAID },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set('Authorization', auth())
        .expect(409);

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });

      expect(after.stockQuantity).toBe(8);

      // A PAID order still holds its stock: 8 remaining + 2 held = 10.
      await assertStockConserved(prisma, product.id, 10);

      const reread = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });

      expect(reread.status).toBe(OrderStatus.PAID);
      expect(reread.cancelledAt).toBeNull();
    });

    it('still returns 200 idempotently on an already-CANCELLED order', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 10,
      });
      const cancelledAt = new Date();
      const order = await createOrder(
        prisma,
        userId,
        [
          {
            productId: product.id,
            productName: product.name,
            unitPriceCents: product.priceCents,
            quantity: 2,
          },
        ],
        { status: OrderStatus.CANCELLED, cancelledAt },
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.id}/cancel`)
        .set('Authorization', auth())
        .expect(200);

      const body = response.body as OrderListItem;
      expect(body).toMatchObject({
        id: order.id,
        status: OrderStatus.CANCELLED,
      });
      expect(body.cancelledAt).toBe(cancelledAt.toISOString());

      // Stock was never taken by the factory and must not be handed back.
      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(after.stockQuantity).toBe(10);
    });
  });

  // markPaid has no HTTP route until Task 7, but it is reachable here exactly
  // as the concurrency suites reach TokenService: resolve the provider and
  // drive it through a real prisma.$transaction against the real database.
  // These tests observe the STATE TRANSITION, not the shape of a Prisma
  // argument, so removing `status: PENDING` from the CAS fails them by
  // transitioning an order that must not be transitioned.
  describe('OrdersService.markPaid against the real database', () => {
    const pendingOrder = async (): Promise<string> => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const order = await createOrder(prisma, userId, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 1,
        },
      ]);

      return order.id;
    };

    const markPaid = async (orderId: string): Promise<string> => {
      const orders = app.get(OrdersService);

      return prisma.$transaction((tx) => orders.markPaid(tx, orderId));
    };

    it('transitions PENDING to PAID once, then reports already-paid', async () => {
      const orderId = await pendingOrder();

      expect(await markPaid(orderId)).toBe('paid');
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
          .status,
      ).toBe(OrderStatus.PAID);

      // A duplicate delivery must not write a second time.
      expect(await markPaid(orderId)).toBe('already-paid');
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
          .status,
      ).toBe(OrderStatus.PAID);
    });

    it('leaves a CANCELLED order cancelled and reports cancelled', async () => {
      const orderId = await pendingOrder();
      const cancelledAt = new Date();
      await prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED, cancelledAt },
      });

      expect(await markPaid(orderId)).toBe('cancelled');

      const reread = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(reread.status).toBe(OrderStatus.CANCELLED);
      expect(reread.cancelledAt).toEqual(cancelledAt);
    });

    it('reports not-found for an unknown order without throwing', async () => {
      await expect(
        markPaid('00000000-0000-7000-8000-000000000000'),
      ).resolves.toBe('not-found');
    });
  });
});
