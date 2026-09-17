import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';

interface OrderResponseBody {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    unitPriceCents: number;
    quantity: number;
    lineTotalCents: number;
  }>;
}

describe('Checkout (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let token: string;

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
    token = await tokens.signAccessToken(user);
  });

  const auth = (): string => `Bearer ${token}`;

  const addToCart = async (
    productId: string,
    quantity: number,
  ): Promise<void> => {
    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${productId}`)
      .set('Authorization', auth())
      .send({ quantity })
      .expect(200);
  };

  const checkout = (key: string) =>
    request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', auth())
      .set('Idempotency-Key', key);

  it('creates an order, decrements stock, and empties the cart', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
      priceCents: 2500,
    });
    await addToCart(product.id, 2);

    const response = await checkout('key-aaaaaaaa').expect(201);
    const body = response.body as OrderResponseBody;

    expect(body.status).toBe('PENDING');
    expect(body.totalCents).toBe(5000);
    expect(body.items[0]).toMatchObject({
      productName: product.name,
      unitPriceCents: 2500,
      quantity: 2,
      lineTotalCents: 5000,
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(8);
    expect(await prisma.cartItem.count()).toBe(0);
  });

  it('409s on an empty cart', async () => {
    await checkout('key-bbbbbbbb').expect(409);
  });

  it('rolls back every decrement when one line cannot be satisfied', async () => {
    const category = await createCategory(prisma);
    // Checkout decrements in ascending productId order, so this test only
    // proves a rollback if `available` (which has stock, and so decrements
    // successfully) is processed BEFORE `soldOut` (which refuses and rolls
    // the transaction back). uuid7 ids are time-based but not strictly
    // ordered within the same millisecond, so relying on creation order
    // alone would make this pass vacuously on an unlucky tie: soldOut could
    // refuse first, nothing would ever be decremented, and every assertion
    // below would still hold without proving rollback happened. Fixed ids
    // pin the sort order instead of leaving it to timing.
    const available = await createProduct(prisma, category.id, {
      id: '00000000-0000-7000-8000-000000000001',
      stockQuantity: 10,
    });
    const soldOut = await createProduct(prisma, category.id, {
      id: '00000000-0000-7000-8000-000000000002',
      stockQuantity: 0,
    });
    expect(available.id < soldOut.id).toBe(true);

    await addToCart(available.id, 1);
    await addToCart(soldOut.id, 1);

    await checkout('key-cccccccc').expect(409);

    const unchanged = await prisma.product.findUniqueOrThrow({
      where: { id: available.id },
    });
    expect(unchanged.stockQuantity).toBe(10);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.cartItem.count()).toBe(2);
  });

  it('409s when a product is deactivated after it was added to the cart', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });
    await addToCart(product.id, 1);
    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: false },
    });

    await checkout('key-dddddddd').expect(409);

    const unchanged = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(unchanged.stockQuantity).toBe(5);
  });

  // The 'missing' StockRefusal branch (a cart item whose product row is gone)
  // has no legitimate reachable path here: CartItem.productId is
  // onDelete: Restrict and products are only ever soft-deactivated, never
  // deleted, so producing it would require a raw SQL write that bypasses the
  // client — banned by CLAUDE.md's testing conventions. It is covered by
  // checkout.service.spec.ts's describeRefusal mapping test instead.

  it('422s on a mixed-currency cart', async () => {
    const category = await createCategory(prisma);
    const usd = await createProduct(prisma, category.id, { currency: 'USD' });
    const eur = await createProduct(prisma, category.id, { currency: 'EUR' });
    await addToCart(usd.id, 1);
    await addToCart(eur.id, 1);

    await checkout('key-eeeeeeee').expect(422);
    expect(await prisma.order.count()).toBe(0);
  });

  it('422s when the total would overflow the INT column', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      priceCents: 2_000_000_000,
      stockQuantity: 10,
    });
    await addToCart(product.id, 2);

    await checkout('key-ffffffff').expect(422);
  });

  it('replays a key instead of creating a second order', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    await addToCart(product.id, 1);

    const first = await checkout('key-gggggggg').expect(201);
    const replay = await checkout('key-gggggggg').expect(200);
    const firstBody = first.body as OrderResponseBody;
    const replayBody = replay.body as OrderResponseBody;

    expect(replayBody.id).toBe(firstBody.id);
    expect(await prisma.order.count()).toBe(1);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(9);
  });

  it('scopes keys to the user', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    await addToCart(product.id, 1);
    await checkout('key-hhhhhhhh').expect(201);

    const other = await createUser(prisma);
    const otherToken = await tokens.signAccessToken(other);
    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ quantity: 1 })
      .expect(200);

    const theirs = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${otherToken}`)
      .set('Idempotency-Key', 'key-hhhhhhhh')
      .expect(201);

    expect(await prisma.order.count()).toBe(2);
    expect((theirs.body as OrderResponseBody).items).toHaveLength(1);
  });

  it('400s on a missing or malformed Idempotency-Key', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', auth())
      .expect(400);

    await checkout('short').expect(400);
    await checkout('has spaces and symbols!!').expect(400);
  });

  it('keeps order lines immutable when the catalog changes afterwards', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
      priceCents: 1500,
      name: 'Original Name',
    });
    await addToCart(product.id, 2);

    const order = await checkout('key-iiiiiiii').expect(201);
    const orderBody = order.body as OrderResponseBody;

    await prisma.product.update({
      where: { id: product.id },
      data: { priceCents: 9900, name: 'Renamed' },
    });

    const reread = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderBody.id}`)
      .set('Authorization', auth())
      .expect(200);
    const rereadBody = reread.body as OrderResponseBody;

    expect(rereadBody.items[0]).toMatchObject({
      productName: 'Original Name',
      unitPriceCents: 1500,
      lineTotalCents: 3000,
    });
    expect(rereadBody.totalCents).toBe(3000);
  });

  it('401s without a token', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Idempotency-Key', 'key-jjjjjjjj')
      .expect(401);
  });
});
