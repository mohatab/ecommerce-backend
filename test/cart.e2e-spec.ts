import { INestApplication } from '@nestjs/common';
import type { Server } from 'net';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';

interface CartResponseBody {
  items: Array<{ quantity: number }>;
  totalCents: number;
}

describe('Cart (e2e)', () => {
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

  it('reads an empty cart without creating a row', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', auth())
      .expect(200);

    expect(response.body).toEqual({ items: [], totalCents: 0 });
    expect(await prisma.cart.count()).toBe(0);
  });

  it('SETS the quantity rather than accumulating it (D11)', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${product.id}`)
        .set('Authorization', auth())
        .send({ quantity: 2 })
        .expect(200);
    }

    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', auth())
      .expect(200);

    const body = response.body as CartResponseBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].quantity).toBe(2);
    expect(body.totalCents).toBe(product.priceCents * 2);
  });

  it('rejects quantity 0 and 100 with 400', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    for (const quantity of [0, 100]) {
      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${product.id}`)
        .set('Authorization', auth())
        .send({ quantity })
        .expect(400);
    }
  });

  it('404s for an unknown or inactive product', async () => {
    const category = await createCategory(prisma);
    const inactive = await createProduct(prisma, category.id, {
      isActive: false,
    });

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${inactive.id}`)
      .set('Authorization', auth())
      .send({ quantity: 1 })
      .expect(404);

    await request(app.getHttpServer())
      .put('/api/v1/cart/items/0195f0a0-0000-7000-8000-0000000000ff')
      .set('Authorization', auth())
      .send({ quantity: 1 })
      .expect(404);
  });

  it('422s on the 51st distinct line', async () => {
    const category = await createCategory(prisma);
    const products = [];

    for (let index = 0; index < 51; index += 1) {
      products.push(await createProduct(prisma, category.id));
    }

    for (const product of products.slice(0, 50)) {
      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${product.id}`)
        .set('Authorization', auth())
        .send({ quantity: 1 })
        .expect(200);
    }

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${products[50].id}`)
      .set('Authorization', auth())
      .send({ quantity: 1 })
      .expect(422);
  });

  it('removes a line idempotently', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', auth())
      .send({ quantity: 1 })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', auth())
      .expect(204);

    await request(app.getHttpServer())
      .delete(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', auth())
      .expect(204);

    expect(await prisma.cartItem.count()).toBe(0);
  });

  it('keeps carts private to their owner', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const other = await createUser(prisma);
    const otherToken = await tokens.signAccessToken(other);

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', auth())
      .send({ quantity: 4 })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);

    expect((response.body as CartResponseBody).items).toEqual([]);
    expect(userId).not.toBe(other.id);
  });

  it('401s without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/cart').expect(401);
  });

  describe('parallel request harness', () => {
    // Existing suites hand supertest an unlistened server, which makes
    // supertest call listen(0) itself per request. That is safe sequentially
    // and breaks under Promise.all. Concurrency suites must listen first.
    it('serves 10 simultaneous requests from one listening server', async () => {
      await app.listen(0);

      try {
        const responses = await Promise.all(
          Array.from({ length: 10 }, () =>
            request(app.getHttpServer())
              .get('/api/v1/cart')
              .set('Authorization', auth()),
          ),
        );

        expect(responses.map((response) => response.status)).toEqual(
          Array.from({ length: 10 }, () => 200),
        );
      } finally {
        await new Promise<void>((resolve) =>
          (app.getHttpServer() as Server).close(() => resolve()),
        );
      }
    });
  });
});
