import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../../config/configuration';
import {
  FakePaymentProvider,
  WEBHOOK_TOLERANCE_SECONDS,
} from './fake-payment.provider';
import {
  AMOUNT_LIMITS,
  AmountLimits,
  CreatePaymentInput,
  PaymentProvider,
  SUPPORTED_EVENT_TYPE,
} from './payment-provider';

const SECRET = 'fake-webhook-secret-value';

function configStub(): ConfigService<AppConfig, true> {
  return {
    get: (key: string): unknown =>
      key === 'payments.webhookSecret' ? SECRET : undefined,
  } as unknown as ConfigService<AppConfig, true>;
}

function eventPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type: SUPPORTED_EVENT_TYPE,
    providerPaymentId: 'pi_1',
    orderId: 'order-1',
    amountMinorUnits: 1000,
    currency: 'usd',
    ...overrides,
  });
}

/**
 * Mirrors the three rules in spec §5.4 that PaymentsService will apply in
 * Task 4. It lives here so the BOUNDARY semantics of AMOUNT_LIMITS are pinned
 * by the phase that defines the constant; the service's own copy is tested
 * where it ships. Nothing in src/ depends on this helper.
 */
function payable(
  limits: AmountLimits | null,
  amountMinorUnits: number,
): boolean {
  return (
    limits !== null &&
    amountMinorUnits >= limits.minMinorUnits &&
    amountMinorUnits <= limits.maxMinorUnits
  );
}

describe('FakePaymentProvider', () => {
  let provider: FakePaymentProvider;

  beforeEach(() => {
    provider = new FakePaymentProvider(configStub());
  });

  const input: CreatePaymentInput = {
    orderId: 'order-1',
    amountMinorUnits: 1000,
    currency: 'USD',
    idempotencyKey: 'order-1',
  };

  describe('the port contract', () => {
    it('implements exactly the four port members and none of the forbidden ones', () => {
      // The annotation is the load-bearing half: this file fails to COMPILE if
      // the fake stops satisfying the port.
      const port: PaymentProvider = provider;

      expect(typeof port.createPayment).toBe('function');
      expect(typeof port.retrievePayment).toBe('function');
      expect(typeof port.verifyWebhook).toBe('function');
      expect(typeof port.amountLimits).toBe('function');

      const surface = provider as unknown as Record<string, unknown>;

      for (const forbidden of [
        'confirmPayment',
        'cancelPayment',
        'refund',
        'capture',
        'void',
        'listPayments',
        'listEvents',
        'getCustomer',
      ]) {
        expect(surface[forbidden]).toBeUndefined();
      }
    });

    it('takes no transaction client: every method arity is its documented one', () => {
      // A `tx` parameter could only arrive as an extra argument. Arity is the
      // cheapest runtime witness of the type-level guarantee in spec §6.2.
      const arity = (name: keyof PaymentProvider): number =>
        (provider[name] as (...args: never[]) => unknown).length;

      expect(arity('createPayment')).toBe(1);
      expect(arity('retrievePayment')).toBe(1);
      expect(arity('verifyWebhook')).toBe(2);
      expect(arity('amountLimits')).toBe(1);
    });
  });

  describe('createPayment', () => {
    it('returns a deterministic payment and counts one create for the key', async () => {
      const created = await provider.createPayment(input);

      expect(created.providerPaymentId).toBe('pi_fake_order-1_1');
      expect(created.clientSecret).toBe('pi_fake_order-1_1_secret_1');
      expect(created.clientSecret).toContain(created.providerPaymentId);
      expect(created.amountMinorUnits).toBe(1000);
      expect(created.currency).toBe('USD');
      expect(provider.createCountFor('order-1')).toBe(1);
    });

    it('returns the SAME payment for a repeated idempotency key', async () => {
      const first = await provider.createPayment(input);
      const second = await provider.createPayment(input);

      expect(second.providerPaymentId).toBe(first.providerPaymentId);
      expect(second.clientSecret).toBe(first.clientSecret);
      expect(second).toEqual(first);
      expect(provider.createCountFor('order-1')).toBe(1);
    });

    it('counts exactly one create per key across many repeats', async () => {
      await Promise.all(
        Array.from({ length: 5 }, () => provider.createPayment(input)),
      );

      expect(provider.createCountFor('order-1')).toBe(1);
    });

    it('issues distinct payments for distinct idempotency keys', async () => {
      const first = await provider.createPayment(input);
      const second = await provider.createPayment({
        ...input,
        orderId: 'order-2',
        idempotencyKey: 'order-2',
      });

      expect(second.providerPaymentId).not.toBe(first.providerPaymentId);
      expect(second.clientSecret).not.toBe(first.clientSecret);
      expect(provider.createCountFor('order-1')).toBe(1);
      expect(provider.createCountFor('order-2')).toBe(1);
    });

    // The whole point of C3: key retention is bounded, so the key alone is
    // NOT a durable guarantee. The durable guarantee is the local Payment
    // row, proven end-to-end in test I1.
    it('issues a NEW payment for the same key once retention has expired', async () => {
      const first = await provider.createPayment(input);

      provider.expireIdempotencyKeys();

      const second = await provider.createPayment(input);

      expect(second.providerPaymentId).not.toBe(first.providerPaymentId);
      expect(provider.createCountFor('order-1')).toBe(2);
    });

    // R3: ONE failure mechanism, two tests. A timeout and an outage are
    // INDISTINGUISHABLE at this boundary — both are a rejected promise, and
    // nothing in Phase 4 branches on which one it was (the service maps any
    // rejection to 502). A second mechanism would add a distinction the
    // production code cannot observe.
    it('throws when told to fail, and does not record a create', async () => {
      provider.failNextCreate('simulated provider outage');

      await expect(provider.createPayment(input)).rejects.toThrow(
        'simulated provider outage',
      );
      expect(provider.createCountFor('order-1')).toBe(0);
    });

    it('surfaces a timeout the same way — a rejected promise, one-shot', async () => {
      const timeout = Object.assign(new Error('connect ETIMEDOUT'), {
        code: 'ETIMEDOUT',
      });

      provider.failNextCreate(timeout);

      await expect(provider.createPayment(input)).rejects.toBe(timeout);
      expect(provider.createCountFor('order-1')).toBe(0);

      // One-shot: the next call succeeds, so a test cannot leak a failure.
      await expect(provider.createPayment(input)).resolves.toMatchObject({
        amountMinorUnits: 1000,
      });
      expect(provider.createCountFor('order-1')).toBe(1);
    });

    // R2 (spec §6.4: the fake "can be told to fail OR to return a mismatched
    // amount"). This is the control the webhook amount check is tested with.
    it('returns a mismatched amount when told to, and remembers the mismatch', async () => {
      provider.mismatchNextCreateAmount(999);

      const created = await provider.createPayment(input);

      expect(created.amountMinorUnits).toBe(999);
      expect(created.amountMinorUnits).not.toBe(input.amountMinorUnits);
      // The provider's own view is authoritative afterwards: a retrieve agrees
      // with what it returned, not with what was asked for.
      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toMatchObject({ amountMinorUnits: 999 });

      // One-shot, like the failure control.
      const next = await provider.createPayment({
        ...input,
        idempotencyKey: 'order-2',
      });

      expect(next.amountMinorUnits).toBe(1000);
    });
  });

  describe('retrievePayment', () => {
    it('returns the same payment that was created, without a new create', async () => {
      const created = await provider.createPayment(input);
      const retrieved = await provider.retrievePayment(
        created.providerPaymentId,
      );

      expect(retrieved).toEqual(created);
      expect(provider.createCountFor('order-1')).toBe(1);
    });

    // Retrieval is a lookup by id: retention does not apply to it.
    it('still returns the payment after idempotency-key retention expires', async () => {
      const created = await provider.createPayment(input);

      provider.expireIdempotencyKeys();

      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toEqual(created);
    });

    it('throws for an unknown id', async () => {
      await expect(provider.retrievePayment('pi_missing')).rejects.toThrow(
        'Unknown payment pi_missing',
      );
    });
  });

  describe('verifyWebhook', () => {
    // The constant-time property itself is NOT observable from a unit test:
    // swapping timingSafeEqual for Buffer.equals leaves all of these green
    // (recorded as a null result in the task report), and a wall-clock timing
    // assertion is flaky in a JIT and proves little. This guards the one thing
    // a future "simplification" would actually remove. Spec §6.4 names
    // crypto.timingSafeEqual specifically.
    it('compares digests with crypto.timingSafeEqual', () => {
      const source = readFileSync(
        join(__dirname, 'fake-payment.provider.ts'),
        'utf8',
      );

      expect(source).toContain('timingSafeEqual(');
    });

    it('accepts a payload signed with the configured secret', () => {
      const payload = eventPayload();
      const event = provider.verifyWebhook(
        Buffer.from(payload),
        provider.signWebhook(payload),
      );

      expect(event.providerEventId).toBe('evt_1');
      expect(event.type).toBe(SUPPORTED_EVENT_TYPE);
      expect(event.providerPaymentId).toBe('pi_1');
      expect(event.orderId).toBe('order-1');
      expect(event.amountMinorUnits).toBe(1000);
    });

    // C8: the wire carries a lowercase code; the domain must never see one.
    it('uppercases the currency on the way in', () => {
      const payload = eventPayload();
      const event = provider.verifyWebhook(
        Buffer.from(payload),
        provider.signWebhook(payload),
      );

      expect(event.currency).toBe('USD');
    });

    it('rejects a tampered body', () => {
      const signature = provider.signWebhook(eventPayload());

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(eventPayload({ amountMinorUnits: 1 })),
          signature,
        ),
      ).toThrow('Invalid signature');
    });

    it('rejects a signature made with a different secret', () => {
      const payload = eventPayload();
      const timestamp = Math.floor(Date.now() / 1000);
      const forged = createHmac('sha256', 'not-the-secret')
        .update(`${timestamp}.${payload}`)
        .digest('hex');

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(payload),
          `t=${timestamp},v1=${forged}`,
        ),
      ).toThrow('Invalid signature');
    });

    // R1: the fake must not be a weaker verifier than Stripe (spec §6.4), and
    // Stripe's verifier has a tolerance window. signWebhook takes an optional
    // timestamp for exactly this test, mirroring Stripe's own
    // generateTestHeaderString({ payload, secret, timestamp }) — no real clock
    // waiting, no fake timers.
    it('rejects a correctly signed but stale timestamp', () => {
      const payload = eventPayload();
      const stale =
        Math.floor(Date.now() / 1000) - WEBHOOK_TOLERANCE_SECONDS - 1;

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(payload),
          provider.signWebhook(payload, stale),
        ),
      ).toThrow('Webhook timestamp outside tolerance');
    });

    it('accepts a signature just inside the tolerance window', () => {
      const payload = eventPayload();
      const fresh =
        Math.floor(Date.now() / 1000) - WEBHOOK_TOLERANCE_SECONDS + 5;

      expect(
        provider.verifyWebhook(
          Buffer.from(payload),
          provider.signWebhook(payload, fresh),
        ).providerEventId,
      ).toBe('evt_1');
    });

    it('rejects a far-future timestamp', () => {
      const payload = eventPayload();
      const future =
        Math.floor(Date.now() / 1000) + WEBHOOK_TOLERANCE_SECONDS + 1;

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(payload),
          provider.signWebhook(payload, future),
        ),
      ).toThrow('Webhook timestamp outside tolerance');
    });

    it('rejects a signature whose timestamp was moved after signing', () => {
      const payload = eventPayload();
      const timestamp = Math.floor(Date.now() / 1000);
      const header = provider.signWebhook(payload, timestamp);
      const moved = header.replace(`t=${timestamp}`, `t=${timestamp - 1}`);

      expect(() => provider.verifyWebhook(Buffer.from(payload), moved)).toThrow(
        'Invalid signature',
      );
    });

    it('rejects a missing or malformed signature header', () => {
      const payload = eventPayload();
      const body = Buffer.from(payload);

      expect(() => provider.verifyWebhook(body, '')).toThrow();
      expect(() => provider.verifyWebhook(body, 'not-hex')).toThrow();
      expect(() => provider.verifyWebhook(body, 't=,v1=')).toThrow();
      expect(() => provider.verifyWebhook(body, 'v1=deadbeef')).toThrow();
      expect(() =>
        provider.verifyWebhook(body, `t=${Math.floor(Date.now() / 1000)}`),
      ).toThrow();
    });

    // The signature binds the EXACT bytes, not the parsed object. This payload
    // does not survive JSON.parse -> JSON.stringify, so a verifier that
    // re-serialised before hashing would accept the round-tripped body too.
    it('binds the exact raw bytes, not the parsed JSON', () => {
      const pretty = JSON.stringify(JSON.parse(eventPayload()), null, 2);
      const compact = JSON.stringify(JSON.parse(pretty));

      expect(compact).not.toBe(pretty);

      const signature = provider.signWebhook(pretty);

      expect(
        provider.verifyWebhook(Buffer.from(pretty), signature).providerEventId,
      ).toBe('evt_1');
      expect(() =>
        provider.verifyWebhook(Buffer.from(compact), signature),
      ).toThrow('Invalid signature');
    });

    it('rejects a correctly signed but unusable payload', () => {
      const payload = '{"id":"evt_2"}';

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(payload),
          provider.signWebhook(payload),
        ),
      ).toThrow('Malformed event payload');
    });

    it('rejects correctly signed non-JSON', () => {
      const payload = 'not json at all';

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(payload),
          provider.signWebhook(payload),
        ),
      ).toThrow();
    });
  });

  describe('amountLimits', () => {
    it('returns the one shared constant, not a private copy', () => {
      // Identity, not equality: this is what "defined ONCE, both adapters read
      // from it" (spec §5.4) means in a test.
      expect(provider.amountLimits('USD')).toBe(AMOUNT_LIMITS.USD);
    });

    it('admits the lower and upper bounds', () => {
      const limits = provider.amountLimits('USD');

      expect(payable(limits, AMOUNT_LIMITS.USD.minMinorUnits)).toBe(true);
      expect(payable(limits, AMOUNT_LIMITS.USD.maxMinorUnits)).toBe(true);
    });

    it('refuses one minor unit outside each bound', () => {
      const limits = provider.amountLimits('USD');

      expect(payable(limits, AMOUNT_LIMITS.USD.minMinorUnits - 1)).toBe(false);
      expect(payable(limits, AMOUNT_LIMITS.USD.maxMinorUnits + 1)).toBe(false);
    });

    it('returns null for a currency that is not payable in Phase 4', () => {
      expect(provider.amountLimits('EUR')).toBeNull();
      expect(provider.amountLimits('usd')).toBeNull();
      expect(provider.amountLimits('')).toBeNull();
      expect(payable(provider.amountLimits('EUR'), 1000)).toBe(false);
    });
  });

  it('reset() clears intents, counters and retention', async () => {
    const created = await provider.createPayment(input);

    provider.reset();

    expect(provider.createCountFor('order-1')).toBe(0);
    await expect(
      provider.retrievePayment(created.providerPaymentId),
    ).rejects.toThrow();
  });
});
