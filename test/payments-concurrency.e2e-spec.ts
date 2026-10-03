import { INestApplication } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import {
  PAYMENT_PROVIDER,
  SUPPORTED_EVENT_TYPE,
} from '../src/modules/payments/provider/payment-provider';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { assertStockConserved } from './helpers/assert-stock-conserved';
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
}

const paymentBody = (response: { body: unknown }): PaymentBody =>
  response.body as PaymentBody;

interface Scenario {
  token: string;
  product: { id: string };
  order: OrderWithItems;
  initialStock: number;
}

interface ScenarioOptions {
  totalCents?: number;
  stock?: number;
  currency?: string;
}

/**
 * Spec §15.3. The six claims Phase 4 rests on, each proved under real parallel
 * HTTP against real Postgres, and each paired with a recorded negative control
 * that fails against the naive implementation it protects. The controls are
 * applied by hand, observed, and reverted; see
 * .superpowers/sdd/2026-09-23-phase-4-payments/task-8-report.md for the
 * captured output. No naive code is committed and no test-only switch exists
 * in src/.
 *
 * Harness rules, each established by a real failure in Phase 3:
 *  - `await app.listen(0)`: supertest against an unlistened server calls
 *    listen(0) per request, which throws ERR_SERVER_ALREADY_LISTEN under
 *    Promise.all;
 *  - `createTestApp([], { throttleLimit: 0 })`: a boolean trigger, not a cap.
 *    This suite far exceeds the webhook handler's 300/min;
 *  - tokens minted through TokenService, never /auth/login, so the 5/min auth
 *    throttle is never in the loop;
 *  - `provider.reset()` beside `truncateAll()`: the fake's state is in memory
 *    and truncation does not touch it;
 *  - every test asserts that no response is a 500 — a 500 would otherwise
 *    masquerade as a correct refusal.
 */
describe('Payments concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let provider: FakePaymentProvider;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);

    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    provider.reset();
  });

  async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
    const totalCents = options.totalCents ?? 1000;
    const stock = options.stock ?? 10;
    const user = await createUser(prisma);
    const token = await tokens.signAccessToken(user);
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      priceCents: totalCents,
      stockQuantity: stock,
    });
    const order = await createOrder(
      prisma,
      user.id,
      [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: totalCents,
          quantity: 1,
        },
      ],
      options.currency === undefined ? {} : { currency: options.currency },
    );

    // createOrder bypasses checkout and therefore does NOT decrement stock.
    // Mirroring the decrement here is what makes assertStockConserved
    // meaningful: without it the order holds a unit the product never gave up.
    await prisma.product.update({
      where: { id: product.id },
      data: { stockQuantity: stock - 1 },
    });

    return { token, product, order, initialStock: stock };
  }

  function eventBody(
    order: { id: string; totalCents: number },
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      id: `evt_${order.id}`,
      type: SUPPORTED_EVENT_TYPE,
      providerPaymentId: `pi_${order.id}`,
      orderId: order.id,
      amountMinorUnits: order.totalCents,
      // Lowercase on purpose: the adapter normalises on the way in (C8), and
      // a real provider sends lowercase.
      currency: 'usd',
      ...overrides,
    });
  }

  /**
   * The id FakePaymentProvider will mint for the FIRST intent of a test.
   *
   * Deterministic because reset() zeroes the sequence in beforeEach. P4's
   * concurrent half needs it: a webhook carrying an intent id the provider
   * never minted makes initiation's replay branch call
   * retrievePayment(<unknown id>), which correctly 502s — a test artefact, not
   * a defect, but it would make the race's outcome depend on who won.
   */
  const firstIntentId = (orderId: string): string => `pi_fake_${orderId}_1`;

  /**
   * How many intents the provider actually HOLDS for an order, counted by
   * probing its retrievePayment port for each id the fake's deterministic
   * scheme could have minted.
   *
   * This is deliberately independent of `createCountFor`, which is keyed by
   * the idempotency KEY: a naive per-call key leaves that counter at 0 for the
   * order while still stranding one intent per call. Only this probe
   * distinguishes "one intent was minted" from "several were minted and all
   * but one discarded", so it is what makes P3's and I1's evidence legible.
   */
  const mintedIntents = async (
    orderId: string,
    upTo: number,
  ): Promise<number> => {
    let minted = 0;

    for (let sequence = 1; sequence <= upTo; sequence += 1) {
      try {
        await provider.retrievePayment(`pi_fake_${orderId}_${sequence}`);
        minted += 1;
      } catch {
        // retrievePayment rejects for an id the fake never minted.
      }
    }

    return minted;
  };

  const deliver = (body: string) =>
    request(app.getHttpServer())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', provider.signWebhook(body))
      .send(body);

  const initiate = (orderId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${token}`);

  const cancel = (orderId: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${token}`);

  const statuses = (responses: { status: number }[]): Record<number, number> =>
    responses.reduce<Record<number, number>>((counts, response) => {
      counts[response.status] = (counts[response.status] ?? 0) + 1;

      return counts;
    }, {});

  /** Listed rather than counted, so a failure prints which codes appeared. */
  const expectNoServerErrors = (responses: { status: number }[]): void => {
    expect(responses.filter((response) => response.status >= 500)).toEqual([]);
  };

  it('P1: 20 concurrent duplicate deliveries transition the order exactly once', async () => {
    const { order, product, initialStock } = await scenario();
    const body = eventBody(order);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => deliver(body)),
    );

    // Control (dedupe replaced with findUnique -> create): every transaction
    // reads null, all 20 insert, the unique index lets one through and the
    // rest raise P2002, which HttpExceptionFilter maps to 409.
    expect(statuses(responses)).toEqual({ 200: 20 });
    expectNoServerErrors(responses);

    expect(await prisma.paymentEvent.count()).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
      1,
    );

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.status).toBe(OrderStatus.PAID);
    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    await assertStockConserved(prisma, product.id, initialStock);
  });

  it('P2: a concurrent cancel and webhook success resolve to exactly one legal outcome', async () => {
    const { order, token, product, initialStock } = await scenario();

    const [cancelled, webhook] = await Promise.all([
      cancel(order.id, token),
      deliver(eventBody(order)),
    ]);

    expectNoServerErrors([cancelled, webhook]);
    expect(webhook.status).toBe(200);
    // 200 if the cancel won, 409 if the payment did. Nothing else is legal.
    expect([200, 409]).toContain(cancelled.status);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    // The corruption this guards, asserted before the branches so it is
    // checked whoever won: PAID with the stock handed back means the goods
    // were both sold and returned.
    expect(
      reread.status === OrderStatus.PAID &&
        after.stockQuantity === initialStock,
    ).toBe(false);

    if (reread.status === OrderStatus.PAID) {
      expect(after.stockQuantity).toBe(initialStock - 1);
      expect(cancelled.status).toBe(409);
    } else {
      // The late payment is still recorded SUCCEEDED for reconciliation; the
      // order stays CANCELLED and is not refunded (spec §17.1).
      expect(reread.status).toBe(OrderStatus.CANCELLED);
      expect(after.stockQuantity).toBe(initialStock);
      expect(cancelled.status).toBe(200);
    }

    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
    await assertStockConserved(prisma, product.id, initialStock);
  });

  it('P3: 15 concurrent initiations create exactly one payment and one intent', async () => {
    const { order, token } = await scenario();

    const responses = await Promise.all(
      Array.from({ length: 15 }, () => initiate(order.id, token)),
    );

    expectNoServerErrors(responses);
    expect(statuses(responses)).toEqual({ 201: 1, 200: 14 });

    // The provider itself created exactly one intent under the order's
    // deterministic key, and HOLDS exactly one intent for the order however it
    // was keyed. The second assertion is the one a per-call key cannot satisfy
    // by accident.
    expect(await mintedIntents(order.id, 15)).toBe(1);
    expect(provider.createCountFor(order.id)).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
      1,
    );

    const stored = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    const secrets = new Set(
      responses.map((response) => paymentBody(response).clientSecret),
    );
    const ids = new Set(responses.map((response) => paymentBody(response).id));

    expect(secrets.size).toBe(1);
    expect(ids.size).toBe(1);
    expect([...secrets][0]).toContain(stored.providerPaymentId);
  });

  it('P4: a webhook racing initiation still pays the right order', async () => {
    const { order, token } = await scenario();

    // The order is resolved from the SIGNED metadata.orderId, so the webhook
    // does not depend on initiation's local row having committed.
    const [webhook, initiation] = await Promise.all([
      deliver(eventBody(order, { providerPaymentId: firstIntentId(order.id) })),
      initiate(order.id, token),
    ]);

    expectNoServerErrors([webhook, initiation]);
    expect(webhook.status).toBe(200);
    // Initiation either persisted the row first (201), found the webhook's row
    // for the same intent (200), or found the order already paid (409). All
    // three are correct; nothing else is.
    expect([200, 201, 409]).toContain(initiation.status);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(reread.status).toBe(OrderStatus.PAID);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
      1,
    );
    expect(await prisma.paymentEvent.count()).toBe(1);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('P4b: a webhook for an order with no payment row at all still pays it', async () => {
    const { order } = await scenario();

    // The deterministic half, and the one that cannot flake: there is no
    // initiation at all, so no local Payment row exists and nothing but the
    // signed metadata can identify the order.
    await deliver(
      eventBody(order, { providerPaymentId: 'pi_never_initiated' }),
    ).expect(200);

    const reread = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    // Asserted BEFORE the payment row is read: resolving the order by
    // providerPaymentId instead of the signed metadata leaves the order
    // PENDING and writes no payment at all, and a findUniqueOrThrow here
    // would fail the control on a Prisma error instead of its own assertion.
    expect(reread.status).toBe(OrderStatus.PAID);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
      1,
    );

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(payment.providerPaymentId).toBe('pi_never_initiated');
    expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('I1: after provider key retention expires, replay returns the PERSISTED intent', async () => {
    const { order, token } = await scenario();

    const first = await initiate(order.id, token).expect(201);
    const stored = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    // The provider prunes its idempotency keys. The same key would now yield a
    // NEW intent — which is exactly why the local row, not the key, is the
    // durable guarantee (C3).
    provider.expireIdempotencyKeys();

    const replays = await Promise.all([
      initiate(order.id, token),
      initiate(order.id, token),
      initiate(order.id, token),
    ]);

    expectNoServerErrors(replays);
    expect(statuses(replays)).toEqual({ 200: 3 });

    for (const replay of replays) {
      expect(paymentBody(replay).clientSecret).toBe(
        paymentBody(first).clientSecret,
      );
      // The secret belongs to the intent that was actually persisted.
      expect(paymentBody(replay).clientSecret).toContain(
        stored.providerPaymentId,
      );
    }

    // No second intent was ever created at the provider.
    expect(provider.createCountFor(order.id)).toBe(1);
    expect(await mintedIntents(order.id, 8)).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
      1,
    );

    const reread = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(reread.providerPaymentId).toBe(stored.providerPaymentId);
  });

  it('A1: an unpayable total is refused before any intent is created', async () => {
    const above = await scenario({ totalCents: 100_000_000 });
    const below = await scenario({ totalCents: 49 });
    const foreign = await scenario({ currency: 'EUR' });

    const responses = await Promise.all([
      initiate(above.order.id, above.token),
      initiate(below.order.id, below.token),
      initiate(foreign.order.id, foreign.token),
    ]);

    expectNoServerErrors(responses);
    expect(statuses(responses)).toEqual({ 422: 3 });

    // Asserted on the provider's own counter, not merely on the status: a
    // limit check that runs AFTER createPayment still answers 422 while
    // leaving an intent behind for an order that can never be paid.
    expect(provider.createCountFor(above.order.id)).toBe(0);
    expect(provider.createCountFor(below.order.id)).toBe(0);
    expect(provider.createCountFor(foreign.order.id)).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('A1b: the exact boundary values are payable', async () => {
    const min = await scenario({ totalCents: 50 });
    const max = await scenario({ totalCents: 99_999_999 });

    await initiate(min.order.id, min.token).expect(201);
    await initiate(max.order.id, max.token).expect(201);

    expect(provider.createCountFor(min.order.id)).toBe(1);
    expect(provider.createCountFor(max.order.id)).toBe(1);
  });
});
