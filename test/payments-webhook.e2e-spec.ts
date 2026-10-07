import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  SUPPORTED_EVENT_TYPE,
} from '../src/modules/payments/provider/payment-provider';
import {
  FakePaymentProvider,
  WEBHOOK_TOLERANCE_SECONDS,
} from '../src/modules/payments/provider/fake-payment.provider';
import { TokenService } from '../src/modules/auth/token.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { assertStockConserved } from './helpers/assert-stock-conserved';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { createOrder } from './factories/order.factory';

/** response.body is `any`; cast once, as every other e2e suite does. */
interface AckBody {
  received: boolean;
}

/** The HttpExceptionFilter shape, for the no-leak assertion below. */
interface ErrorBody {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path: string;
}

describe('Payment webhook — signature boundary (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // The provider's state is in memory: truncateAll does not touch it.
    provider.reset();
  });

  function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: 'evt_1',
      type: SUPPORTED_EVENT_TYPE,
      providerPaymentId: 'pi_1',
      orderId: '0195f0a0-0000-7000-8000-0000000000aa',
      amountMinorUnits: 1000,
      currency: 'usd',
      ...overrides,
    });
  }

  const deliver = (body: string, signature: string | null) => {
    const call = request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json');

    return (
      signature === null ? call : call.set('stripe-signature', signature)
    ).send(body);
  };

  it('accepts a correctly signed delivery with 200', async () => {
    const body = payload();

    const response = await deliver(body, provider.signWebhook(body)).expect(
      200,
    );

    expect(response.body as AckBody).toEqual({ received: true });
  });

  it('rejects a delivery with no signature header', async () => {
    await deliver(payload(), null).expect(400);
  });

  it('rejects a delivery with a wrong signature', async () => {
    await deliver(payload(), 'a'.repeat(64)).expect(400);
  });

  it('rejects a body that was tampered with after signing', async () => {
    const signature = provider.signWebhook(payload());

    await deliver(payload({ amountMinorUnits: 1 }), signature).expect(400);
  });

  it('rejects a correctly signed but unusable payload', async () => {
    const body = '{"id":"evt_2"}';

    await deliver(body, provider.signWebhook(body)).expect(400);
  });

  it('acknowledges a signed event of an unsupported type without persisting it', async () => {
    const body = payload({ type: 'payment_intent.payment_failed' });

    await deliver(body, provider.signWebhook(body)).expect(200);

    expect(await prisma.paymentEvent.count()).toBe(0);
  });

  it('requires no authentication — @Public() is what makes delivery possible', async () => {
    const body = payload();

    // No Authorization header anywhere in this suite; a 401 here would mean
    // @Public() was dropped and no order could ever be paid.
    await deliver(body, provider.signWebhook(body)).expect(200);
  });

  /**
   * M3: the 400 body is the BARE constant and nothing else.
   *
   * Two different internal refusals — a digest mismatch and a stale timestamp
   * — must produce byte-identical bodies, or the response itself tells an
   * attacker which half of the header to fix. The unit test pins the message;
   * this pins the whole body at the boundary where it actually reaches a
   * client, including that no stack, no cause and no provider text rides along
   * in an extra field.
   */
  it('returns only the bare refusal, whatever the internal reason', async () => {
    const body = payload();
    const stale = provider.signWebhook(
      body,
      Math.floor(Date.now() / 1000) - WEBHOOK_TOLERANCE_SECONDS - 60,
    );

    for (const signature of ['a'.repeat(64), stale]) {
      const response = await deliver(body, signature).expect(400);
      const error = response.body as ErrorBody;

      expect(error.message).toBe('Invalid signature');
      expect(error.error).toBe('Bad Request');
      expect(error.path).toBe('/api/v1/payments/webhook');
      expect(Object.keys(error).sort()).toEqual([
        'error',
        'message',
        'path',
        'statusCode',
        'timestamp',
      ]);
    }
  });

  /**
   * THE RAW-BODY REGRESSION.
   *
   * This payload survives JSON.parse but NOT a parse/re-stringify round trip:
   * the key order and the spacing both change, and so does the HMAC. If
   * anything ever verifies against a re-serialised body — or if
   * NEST_APP_OPTIONS stops reaching the app — this signature stops matching
   * and the test fails. Without it, that breakage looks like a signing bug.
   */
  it('verifies against the exact bytes sent, not a re-serialised body', async () => {
    const body =
      '{"z":1,  "type":"' +
      SUPPORTED_EVENT_TYPE +
      '","id":"evt_3",' +
      '"providerPaymentId":"pi_3","orderId":"0195f0a0-0000-7000-8000-0000000000ab",' +
      '"amountMinorUnits":1000,"currency":"usd"}';

    expect(JSON.stringify(JSON.parse(body))).not.toBe(body);

    await deliver(body, provider.signWebhook(body)).expect(200);
  });
});

describe('Payment webhook — state application (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // In-memory provider state; truncateAll does not touch it.
    provider.reset();
  });

  async function paidCandidate(totalCents = 1000) {
    const user = await createUser(prisma);
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

    // Mirror what checkout would have done to stock, so conservation holds.
    await prisma.product.update({
      where: { id: product.id },
      data: { stockQuantity: 9 },
    });

    return { user, product, order };
  }

  function eventFor(
    order: { id: string; totalCents: number },
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      id: `evt_${order.id}`,
      type: SUPPORTED_EVENT_TYPE,
      providerPaymentId: `pi_${order.id}`,
      orderId: order.id,
      amountMinorUnits: order.totalCents,
      currency: 'usd',
      ...overrides,
    });
  }

  const send = (body: string) =>
    request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', provider.signWebhook(body))
      .send(body);

  it('marks a PENDING order PAID and records the payment and the event', async () => {
    const { order } = await paidCandidate();

    await send(eventFor(order)).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe('PAID');
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.succeededAt).not.toBeNull();
    expect(await prisma.paymentEvent.count()).toBe(1);
  });

  it('never changes stock when an order is paid', async () => {
    const { order, product } = await paidCandidate();

    await send(eventFor(order)).expect(200);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    expect(after.stockQuantity).toBe(9);
    // A PAID order still holds its unit: 9 remaining + 1 held = 10.
    await assertStockConserved(prisma, product.id, 10);
  });

  it('is idempotent across a repeated delivery of the same event', async () => {
    const { order } = await paidCandidate();
    const body = eventFor(order);

    await send(body).expect(200);
    const first = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    await send(body).expect(200);
    const second = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(await prisma.paymentEvent.count()).toBe(1);
    expect(second.succeededAt).toEqual(first.succeededAt);
  });

  /**
   * THE EVENT-TYPE CONTROL, replacing the controller's Task 6 debug-log pin.
   *
   * A `charge.refunded` delivery is validly signed and normalises into a
   * well-formed ProviderEvent carrying a `ch_…` id — the adapters' field
   * checks are structural, not type discriminants. The caller-side
   * `event.type !== SUPPORTED_EVENT_TYPE` comparison is the only thing
   * between it and state application, and from this task on deleting that
   * comparison suppresses a REAL write: this order would become PAID.
   */
  it('acknowledges a signed charge.refunded without touching any state', async () => {
    const { order } = await paidCandidate();

    await send(
      eventFor(order, { type: 'charge.refunded', providerPaymentId: 'ch_1' }),
    ).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(reread.status).toBe('PENDING');
    expect(await prisma.paymentEvent.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('records an event for an unknown order without changing anything', async () => {
    const body = eventFor({
      id: '0195f0a0-0000-7000-8000-0000000000cc',
      totalCents: 1000,
    });

    await send(body).expect(200);

    expect(await prisma.paymentEvent.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('records but does not pay on an amount mismatch', async () => {
    const { order } = await paidCandidate();

    await send(eventFor(order, { amountMinorUnits: 999 })).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(reread.status).toBe('PENDING');
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.paymentEvent.count()).toBe(1);
  });

  it('records but does not pay on a currency mismatch', async () => {
    const { order } = await paidCandidate();

    await send(eventFor(order, { currency: 'gbp' })).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(reread.status).toBe('PENDING');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('leaves an already-PAID order alone on a second, different event', async () => {
    const { order } = await paidCandidate();

    await send(eventFor(order)).expect(200);
    const first = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    // A DIFFERENT event id, so dedupe cannot be what stops it: the markPaid
    // CAS misses, reports 'already-paid', and nothing is rewritten.
    await send(eventFor(order, { id: 'evt_second' })).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const second = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe('PAID');
    expect(second.succeededAt).toEqual(first.succeededAt);
    expect(await prisma.paymentEvent.count()).toBe(2);
    expect(await prisma.payment.count()).toBe(1);
  });

  /**
   * Re-proves markPaid's `status: PENDING` predicate at the HTTP boundary.
   * Task 4 proved it by driving the service directly; this is the first task
   * with a real caller, and the PAID transition must not be reachable from a
   * CANCELLED order through it either.
   *
   * Setting CANCELLED with a direct write is deliberate and allowed: the
   * "reach every paid order through a signed event" rule exists so nothing
   * fakes the transition under test, and the transition under test here is
   * the one that must NOT happen.
   */
  it('leaves a CANCELLED order cancelled but records the payment as SUCCEEDED', async () => {
    const { order } = await paidCandidate();

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    await send(eventFor(order)).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe('CANCELLED');
    expect(payment.status).toBe('SUCCEEDED');
  });

  /**
   * Phase 5, spec §4.3. The same shape as the CANCELLED case above, and
   * reached the same deliberate way: the transition under test is the one
   * that must NOT happen, so EXPIRED is set with a direct write.
   *
   * Before the webhook's outcome `switch`, 'expired' fell past
   * `if (outcome === 'cancelled')` and this path had no observable behaviour
   * whatsoever. The order row is the assertion that it still mutates
   * nothing; the error log itself is pinned in the unit spec, where the
   * logger can be spied on.
   */
  it('leaves an EXPIRED order expired but records the payment as SUCCEEDED', async () => {
    const { order, product } = await paidCandidate();

    // The sweep restored this order's unit before committing the transition
    // (spec §4.5), so undo paidCandidate's mirrored decrement.
    await prisma.product.update({
      where: { id: product.id },
      data: { stockQuantity: 10 },
    });
    const expiredAt = new Date();
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'EXPIRED', expiredAt },
    });

    await send(eventFor(order)).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe('EXPIRED');
    expect(reread.expiredAt).toEqual(expiredAt);
    expect(reread.cancelledAt).toBeNull();
    expect(payment.status).toBe('SUCCEEDED');

    // The webhook touches no stock on any path, and an EXPIRED order holds
    // none: 10 on the row + 0 held === 10 initial.
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('promotes a PENDING payment row created by initiation', async () => {
    const { order, user } = await paidCandidate();
    const token = await app.get(TokenService).signAccessToken(user);

    const initiated = await request(app.getHttpServer())
      .post(`/api/v1/orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const stored = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    await send(
      eventFor(order, { providerPaymentId: stored.providerPaymentId }),
    ).expect(200);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(payment.id).toBe(stored.id);
    expect(payment.status).toBe('SUCCEEDED');
    expect((initiated.body as { id: string }).id).toBe(stored.id);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
      1,
    );
  });

  it('refuses a later initiation once the order is paid', async () => {
    const { order, user } = await paidCandidate();
    const token = await app.get(TokenService).signAccessToken(user);

    await send(eventFor(order)).expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  /**
   * §8.5's last row: a database failure mid-transaction is a 500 with NOTHING
   * persisted. The failure is injected at the LAST statement of the
   * transaction, so the event insert and the payment insert have both really
   * run against Postgres — what this asserts is that the rollback takes them
   * with it, and that the error escapes instead of being swallowed into an
   * ack the provider would never retry.
   */
  it('rolls back and 500s when the transaction fails at the last step', async () => {
    const { order } = await paidCandidate();
    const markPaid = jest
      .spyOn(app.get(OrdersService), 'markPaid')
      .mockRejectedValue(new Error('connection terminated unexpectedly'));

    try {
      await send(eventFor(order)).expect(500);
    } finally {
      markPaid.mockRestore();
    }

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(reread.status).toBe('PENDING');
    expect(await prisma.paymentEvent.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });
});
