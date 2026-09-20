import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { assertStockConserved } from './helpers/assert-stock-conserved';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';

interface Shopper {
  id: string;
  token: string;
}

describe('Checkout concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;

  beforeAll(async () => {
    // throttleLimit bypasses the guard entirely: this suite fires far more
    // than 100 requests per handler and is not testing rate limiting.
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    // Required. Handing supertest an unlistened server makes it call
    // listen(0) per request, which breaks under Promise.all with
    // ERR_SERVER_ALREADY_LISTEN. Proven in test/cart.e2e-spec.ts.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  /** Users come from the factory with tokens minted directly, so the
   *  5/min throttle on /auth/login never applies. */
  const makeShoppers = async (count: number): Promise<Shopper[]> => {
    const shoppers: Shopper[] = [];

    for (let index = 0; index < count; index += 1) {
      const user = await createUser(prisma);
      shoppers.push({ id: user.id, token: await tokens.signAccessToken(user) });
    }

    return shoppers;
  };

  const fillCart = async (
    shopper: Shopper,
    productId: string,
    quantity: number,
  ): Promise<void> => {
    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${productId}`)
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({ quantity })
      .expect(200);
  };

  const checkoutAs = (shopper: Shopper, key: string) =>
    request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${shopper.token}`)
      .set('Idempotency-Key', key);

  const countStatuses = (statuses: number[]): Record<number, number> =>
    statuses.reduce<Record<number, number>>((counts, status) => {
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});

  /** A 500 anywhere would masquerade as a correct rejection. */
  const expectNoServerErrors = (statuses: number[]): void => {
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
  };

  it('C1: 25 simultaneous checkouts sell exactly the 5 units in stock', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });
    const shoppers = await makeShoppers(25);

    for (const shopper of shoppers) {
      await fillCart(shopper, product.id, 1);
    }

    const responses = await Promise.all(
      shoppers.map((shopper, index) =>
        checkoutAs(shopper, `c1-key-${index.toString().padStart(4, '0')}`),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 5, 409: 20 });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(0);
    expect(await prisma.order.count()).toBe(5);

    // The 20 losers rolled back completely: their carts are untouched.
    expect(await prisma.cartItem.count()).toBe(20);

    await assertStockConserved(prisma, product.id, 5);
  });

  it('C2: multi-unit lines cannot oversell either', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const shoppers = await makeShoppers(10);

    for (const shopper of shoppers) {
      await fillCart(shopper, product.id, 3);
    }

    const responses = await Promise.all(
      shoppers.map((shopper, index) =>
        checkoutAs(shopper, `c2-key-${index}0000`),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 3, 409: 7 });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(1);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('C3: opposing multi-product carts do not deadlock', async () => {
    const category = await createCategory(prisma);
    const productA = await createProduct(prisma, category.id, {
      stockQuantity: 50,
    });
    const productB = await createProduct(prisma, category.id, {
      stockQuantity: 50,
    });
    const shoppers = await makeShoppers(20);

    for (const [index, shopper] of shoppers.entries()) {
      // Half add A then B, half add B then A. The service sorts by
      // productId, so both halves must take row locks in the same order.
      const order =
        index % 2 === 0
          ? [productA.id, productB.id]
          : [productB.id, productA.id];

      for (const productId of order) {
        await fillCart(shopper, productId, 1);
      }
    }

    const responses = await Promise.all(
      shoppers.map((shopper, index) =>
        checkoutAs(shopper, `c3-key-${index}0000`),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 20 });

    for (const product of [productA, productB]) {
      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(after.stockQuantity).toBe(30);
      await assertStockConserved(prisma, product.id, 50);
    }
  });

  it('C4: the same idempotency key sent 10 times produces one order', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const [shopper] = await makeShoppers(1);
    await fillCart(shopper, product.id, 2);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => checkoutAs(shopper, 'c4-shared-key')),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 1, 200: 9 });

    const ids = new Set(
      responses.map((response) => (response.body as { id: string }).id),
    );
    expect(ids.size).toBe(1);
    expect(await prisma.order.count()).toBe(1);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(8);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('C5: one cart cannot become two orders under different keys', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const [shopper] = await makeShoppers(1);
    await fillCart(shopper, product.id, 1);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        checkoutAs(shopper, `c5-key-${index}0000`),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 1, 409: 9 });
    expect(await prisma.order.count()).toBe(1);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(9);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('C6: concurrent cancels restore stock exactly once', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const [shopper] = await makeShoppers(1);
    await fillCart(shopper, product.id, 4);
    const order = await checkoutAs(shopper, 'c6-checkout-key').expect(201);
    const orderId = (order.body as { id: string }).id;

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/cancel`)
          .set('Authorization', `Bearer ${shopper.token}`),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 200: 10 });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('C7: a restock during a checkout storm is never lost', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });
    const shoppers = await makeShoppers(10);
    const admin = await createUser(prisma, { role: Role.ADMIN });
    const adminToken = await tokens.signAccessToken(admin);

    for (const shopper of shoppers) {
      await fillCart(shopper, product.id, 1);
    }

    const responses = await Promise.all([
      ...shoppers.map((shopper, index) =>
        checkoutAs(shopper, `c7-key-${index}0000`),
      ),
      request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: 5 }),
    ]);
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);

    const successes = statuses.filter((status) => status === 201).length;
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    expect(after.stockQuantity).toBe(10 - successes);
    await assertStockConserved(prisma, product.id, 5, 5);
  });

  it('C8: parallel first writes create exactly one cart', async () => {
    const category = await createCategory(prisma);
    const products = [];

    for (let index = 0; index < 10; index += 1) {
      products.push(await createProduct(prisma, category.id));
    }

    const [shopper] = await makeShoppers(1);

    const responses = await Promise.all(
      products.map((product) =>
        request(app.getHttpServer())
          .put(`/api/v1/cart/items/${product.id}`)
          .set('Authorization', `Bearer ${shopper.token}`)
          .send({ quantity: 1 }),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 200: 10 });
    expect(await prisma.cart.count()).toBe(1);
    expect(await prisma.cartItem.count()).toBe(10);
  });
});
