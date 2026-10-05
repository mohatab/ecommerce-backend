import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/provider/payment-provider';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { createOrder, OrderWithItems } from './factories/order.factory';

/** response.body is `any`; cast once, as every other e2e suite does. */
interface PaymentBody {
  id: string;
  orderId: string;
  status: string;
  clientSecret: string;
  createdAt: string;
}

interface ErrorBody {
  statusCode: number;
  message: string;
  error: string;
}

const paymentBody = (response: { body: unknown }): PaymentBody =>
  response.body as PaymentBody;

interface Fixture {
  token: string;
  product: { id: string };
  order: OrderWithItems;
}

describe('Payment initiation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);

    // Required by the concurrent-initiation test below: handing supertest an
    // unlistened server makes it call listen(0) per request, which breaks
    // under Promise.all with ERR_SERVER_ALREADY_LISTEN.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // The provider's state is in memory: truncateAll does not touch it.
    provider.reset();
  });

  async function payableOrder(totalCents = 1000): Promise<Fixture> {
    const user = await createUser(prisma);
    const token = await tokens.signAccessToken(user);
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      priceCents: totalCents,
      stockQuantity: 10,
    });
    const order = await createOrder(prisma, user.id, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: totalCents,
        quantity: 1,
      },
    ]);

    return { token, product, order };
  }

  const initiate = (orderId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${token}`);

  describe('happy path', () => {
    it('creates an intent with 201 and returns a client secret', async () => {
      const { order, token } = await payableOrder();

      const response = await initiate(order.id, token).expect(201);

      expect(paymentBody(response).orderId).toBe(order.id);
      expect(paymentBody(response).status).toBe('PENDING');
      expect(typeof paymentBody(response).clientSecret).toBe('string');
      expect(paymentBody(response).clientSecret.length).toBeGreaterThan(0);
      expect(provider.createCountFor(order.id)).toBe(1);
    });

    it('never exposes providerPaymentId in the response', async () => {
      const { order, token } = await payableOrder();
      const response = await initiate(order.id, token).expect(201);

      expect(paymentBody(response)).not.toHaveProperty('providerPaymentId');
    });

    it('leaves the order PENDING — initiation never pays anything (D11)', async () => {
      const { order, token } = await payableOrder();

      await initiate(order.id, token).expect(201);

      const reread = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
      });

      expect(reread.status).toBe('PENDING');
    });
  });

  // §7.2: the client supplies NOTHING that affects money. There is no @Body()
  // parameter, so a junk body is ignored rather than rejected — and in
  // particular an attacker-chosen amount or currency cannot reach the
  // provider, because the only amount the service can read is the persisted
  // one.
  describe('empty body contract', () => {
    it('succeeds with no body at all', async () => {
      const { order, token } = await payableOrder();

      await initiate(order.id, token).expect(201);
    });

    it('ignores a client-supplied amount and currency rather than honouring them', async () => {
      const { order, token } = await payableOrder(1000);

      await initiate(order.id, token)
        .send({
          amountMinorUnits: 1,
          totalCents: 1,
          currency: 'EUR',
          status: 'SUCCEEDED',
          orderId: 'someone-elses-order',
        })
        .expect(201);

      const stored = await prisma.payment.findUniqueOrThrow({
        where: { orderId: order.id },
      });

      // The intent the provider actually holds carries the ORDER's money,
      // not the body's.
      const intent = await provider.retrievePayment(stored.providerPaymentId);

      expect(intent.amountMinorUnits).toBe(1000);
      expect(intent.currency).toBe('USD');
      expect(stored.status).toBe('PENDING');
      expect(stored.orderId).toBe(order.id);
    });
  });

  // S4 / §11.2: the client secret is returned and then forgotten. It is not a
  // column, and it is not smuggled into one.
  describe('clientSecret is never persisted', () => {
    it('stores no column holding it, and no column named like it', async () => {
      const { order, token } = await payableOrder();

      const response = await initiate(order.id, token).expect(201);
      const secret = paymentBody(response).clientSecret;

      const stored = await prisma.payment.findUniqueOrThrow({
        where: { orderId: order.id },
      });

      expect(Object.values(stored)).not.toContain(secret);
      expect(JSON.stringify(stored)).not.toContain(secret);

      // The schema itself, not just this row: no payments column is named
      // anything secret-shaped.
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payments'
      `;

      expect(columns.map((column) => column.column_name).sort()).toEqual([
        'created_at',
        'id',
        'order_id',
        'provider_payment_id',
        'status',
        'succeeded_at',
        'updated_at',
      ]);
    });
  });

  describe('replay', () => {
    it('returns 200 with the same payment on a second call', async () => {
      const { order, token } = await payableOrder();

      const first = await initiate(order.id, token).expect(201);
      const second = await initiate(order.id, token).expect(200);

      expect(paymentBody(second).id).toBe(paymentBody(first).id);
      expect(paymentBody(second).clientSecret).toBe(
        paymentBody(first).clientSecret,
      );
      expect(provider.createCountFor(order.id)).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        1,
      );
    });

    // I1, deterministic half: the local row outlives the provider's key
    // retention window. Task 8 pairs this with its negative control.
    it('still returns the persisted intent after key retention expires', async () => {
      const { order, token } = await payableOrder();

      const first = await initiate(order.id, token).expect(201);

      provider.expireIdempotencyKeys();

      const second = await initiate(order.id, token).expect(200);

      expect(paymentBody(second).clientSecret).toBe(
        paymentBody(first).clientSecret,
      );
      expect(provider.createCountFor(order.id)).toBe(1);

      const stored = await prisma.payment.findUniqueOrThrow({
        where: { orderId: order.id },
      });

      expect(paymentBody(second).clientSecret).toContain(
        stored.providerPaymentId,
      );
    });
  });

  describe('ownership', () => {
    it('404s on another user’s order — not 403, and not 200', async () => {
      const { order } = await payableOrder();
      const intruder = await createUser(prisma);
      const intruderToken = await tokens.signAccessToken(intruder);

      await initiate(order.id, intruderToken).expect(404);

      expect(await prisma.payment.count()).toBe(0);
      expect(provider.createCountFor(order.id)).toBe(0);
    });

    it('404s on an unknown order', async () => {
      const { token } = await payableOrder();

      await initiate('0195f0a0-0000-7000-8000-0000000000ff', token).expect(404);
    });

    it('401s without a token', async () => {
      const { order } = await payableOrder();

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.id}/payments`)
        .expect(401);
    });

    it('400s on a malformed order id', async () => {
      const { token } = await payableOrder();

      await initiate('not-a-uuid', token).expect(400);
    });
  });

  describe('order status', () => {
    it('409s for a cancelled order', async () => {
      const { order, token } = await payableOrder();

      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });

      await initiate(order.id, token).expect(409);
      expect(provider.createCountFor(order.id)).toBe(0);
    });

    it('409s for an order that is already paid', async () => {
      const { order, token } = await payableOrder();

      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'PAID' },
      });

      await initiate(order.id, token).expect(409);
      expect(provider.createCountFor(order.id)).toBe(0);
    });
  });

  // A1, deterministic half.
  describe('payable range', () => {
    it('422s above the maximum, creating no intent', async () => {
      const { order, token } = await payableOrder(100_000_000);

      await initiate(order.id, token).expect(422);
      expect(provider.createCountFor(order.id)).toBe(0);
      expect(await prisma.payment.count()).toBe(0);
    });

    it('422s below the minimum, creating no intent', async () => {
      const { order, token } = await payableOrder(49);

      await initiate(order.id, token).expect(422);
      expect(provider.createCountFor(order.id)).toBe(0);
    });

    it('422s for an unsupported currency', async () => {
      const { order, token } = await payableOrder();

      await prisma.order.update({
        where: { id: order.id },
        data: { currency: 'EUR' },
      });

      await initiate(order.id, token).expect(422);
      expect(provider.createCountFor(order.id)).toBe(0);
    });

    it('accepts an order exactly at each boundary', async () => {
      const low = await payableOrder(50);

      await initiate(low.order.id, low.token).expect(201);

      const high = await payableOrder(99_999_999);

      await initiate(high.order.id, high.token).expect(201);
    });
  });

  describe('provider failure', () => {
    it('502s and persists nothing when the provider rejects', async () => {
      const { order, token } = await payableOrder();

      provider.failNextCreate('simulated outage');

      const response = await initiate(order.id, token).expect(502);
      const body = response.body as ErrorBody;

      expect(JSON.stringify(response.body)).not.toContain('simulated outage');
      expect(body.message).toBe('Payment provider unavailable');
      expect(await prisma.payment.count()).toBe(0);
    });

    it('recovers on the next attempt', async () => {
      const { order, token } = await payableOrder();

      provider.failNextCreate('simulated outage');
      await initiate(order.id, token).expect(502);

      await initiate(order.id, token).expect(201);
    });
  });

  describe('stock', () => {
    it('never changes stock', async () => {
      const { order, token, product } = await payableOrder();
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });

      await initiate(order.id, token).expect(201);

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });

      expect(after.stockQuantity).toBe(before.stockQuantity);
    });
  });

  /**
   * Focused concurrency only — Task 8 owns the full P1-P4/I1/A1 suite.
   *
   * The one claim made here is the §7.4 case-2 guarantee: N simultaneous
   * initiations of ONE order produce exactly one Payment row and exactly one
   * intent at the provider. The per-key create counter is what makes the
   * second half observable; the unique index on orders.id makes the first.
   */
  describe('concurrent initiation', () => {
    it('creates exactly one payment and one intent under 8 simultaneous calls', async () => {
      const { order, token } = await payableOrder();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => initiate(order.id, token)),
      );
      const statuses = responses.map((response) => response.status);

      // A 500 anywhere would masquerade as a correct outcome.
      expect(statuses.filter((status) => status >= 500)).toEqual([]);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 200)).toHaveLength(7);

      expect(provider.createCountFor(order.id)).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        1,
      );

      // Every caller received the same intent's secret, and it is the one
      // that was persisted.
      const stored = await prisma.payment.findUniqueOrThrow({
        where: { orderId: order.id },
      });
      const secrets = new Set(
        responses.map((response) => paymentBody(response).clientSecret),
      );

      expect(secrets.size).toBe(1);
      expect([...secrets][0]).toContain(stored.providerPaymentId);
    });
  });
});
