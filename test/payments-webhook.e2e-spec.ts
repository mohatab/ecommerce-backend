import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  SUPPORTED_EVENT_TYPE,
} from '../src/modules/payments/provider/payment-provider';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';

/** response.body is `any`; cast once, as every other e2e suite does. */
interface AckBody {
  received: boolean;
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

  // Task 6 is the trust boundary only: nothing on this path may write. Task 7
  // replaces this with its own state assertions.
  it('writes nothing at all, for any delivery in this task', async () => {
    const body = payload();

    await deliver(body, provider.signWebhook(body)).expect(200);

    expect(await prisma.paymentEvent.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
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
