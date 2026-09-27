import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AppConfig } from '../../../config/configuration';
import {
  STRIPE_API_VERSION,
  StripePaymentProvider,
} from './stripe-payment.provider';
import {
  AMOUNT_LIMITS,
  AmountLimits,
  PaymentProvider,
  SUPPORTED_EVENT_TYPE,
} from './payment-provider';
import { WEBHOOK_TOLERANCE_SECONDS } from './fake-payment.provider';

const SECRET = 'whsec_test_secret';
const API_KEY = 'sk_test_key';

function configStub(
  overrides: Record<string, unknown> = {},
): ConfigService<AppConfig, true> {
  const values: Record<string, unknown> = {
    'payments.webhookSecret': SECRET,
    'payments.apiKey': API_KEY,
    ...overrides,
  };

  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService<AppConfig, true>;
}

/**
 * The Stripe client is private, as it must be — nothing outside the adapter
 * may hold a Stripe type. Reaching it here is how the SDK boundary is mocked
 * so the tests can assert WHAT WAS PASSED rather than only what came back.
 * One typed accessor, so no test body carries a cast.
 */
function stripeOf(provider: StripePaymentProvider): Stripe {
  return (provider as unknown as { stripe: Stripe }).stripe;
}

type CreateArgs = [Stripe.PaymentIntentCreateParams, Stripe.RequestOptions?];
type CreateMock = jest.Mock<Promise<Stripe.PaymentIntent>, CreateArgs>;
type RetrieveMock = jest.Mock<Promise<Stripe.PaymentIntent>, [string]>;

/**
 * A PaymentIntent has ~40 members and the adapter reads four of them. One
 * cast, here, beats forty irrelevant fields in every fixture.
 */
function stripeIntent(
  overrides: Partial<Stripe.PaymentIntent> = {},
): Stripe.PaymentIntent {
  return {
    id: 'pi_test_1',
    client_secret: 'pi_test_1_secret',
    amount: 1000,
    currency: 'usd',
    ...overrides,
  } as Stripe.PaymentIntent;
}

/**
 * AMOUNT_LIMITS is Partial<Record<...>> by design, so even the one supported
 * entry arrives as AmountLimits | undefined and has to be narrowed once.
 */
function usdLimits(): AmountLimits {
  const limits = AMOUNT_LIMITS.USD;

  if (limits === undefined) {
    throw new Error('AMOUNT_LIMITS.USD must be defined');
  }

  return limits;
}

/** Mirrors the three rules in spec §5.4, as fake-payment.provider.spec.ts does. */
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

function eventPayload(
  intentOverrides: Record<string, unknown> = {},
  eventOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id: 'evt_test_1',
    type: SUPPORTED_EVENT_TYPE,
    ...eventOverrides,
    data: {
      object: {
        id: 'pi_test_1',
        amount: 1000,
        currency: 'usd',
        metadata: { orderId: 'order-1' },
        ...intentOverrides,
      },
    },
  });
}

describe('StripePaymentProvider', () => {
  let provider: StripePaymentProvider;

  beforeEach(() => {
    provider = new StripePaymentProvider(configStub());
  });

  function sign(payload: string, timestamp?: number, secret = SECRET): string {
    return new Stripe(API_KEY).webhooks.generateTestHeaderString({
      payload,
      secret,
      ...(timestamp === undefined ? {} : { timestamp }),
    });
  }

  describe('construction', () => {
    // The brief proposed `configService.get('payments.apiKey') ?? ''`, with a
    // comment arguing Joi makes it unreachable. That is the exact reasoning
    // `requireEnv` in src/config/configuration.ts was written to reject:
    // `new Stripe('')` succeeds and fails later, opaquely.
    it('refuses to construct without an API key, naming the variable', () => {
      expect(
        () =>
          new StripePaymentProvider(
            configStub({ 'payments.apiKey': undefined }),
          ),
      ).toThrow(/PAYMENT_API_KEY/);
    });

    it('refuses to construct on an empty API key', () => {
      expect(
        () => new StripePaymentProvider(configStub({ 'payments.apiKey': '' })),
      ).toThrow(/PAYMENT_API_KEY/);
    });

    // The compile half of the pin lives in the adapter: `apiVersion` is typed
    // `LatestApiVersion = typeof ApiVersion`, so assigning any other string is
    // a BUILD error. This is the runtime half — that the constant we pass is
    // the version the installed SDK ships.
    it('pins the API version to the one the installed SDK ships', () => {
      expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
    });
  });

  describe('createPayment', () => {
    let create: CreateMock;

    beforeEach(() => {
      create = jest
        .fn<Promise<Stripe.PaymentIntent>, CreateArgs>()
        .mockResolvedValue(stripeIntent());
      stripeOf(provider).paymentIntents.create =
        create as unknown as Stripe['paymentIntents']['create'];
    });

    it('passes the amount through unchanged and lowercases the currency', async () => {
      await provider.createPayment({
        orderId: 'order-1',
        amountMinorUnits: 1000,
        currency: 'USD',
        idempotencyKey: 'key-1',
      });

      expect(create.mock.calls[0][0]).toEqual({
        amount: 1000,
        currency: 'usd',
        metadata: { orderId: 'order-1' },
      });
    });

    it('passes the idempotency key through request options, not the body', async () => {
      await provider.createPayment({
        orderId: 'order-1',
        amountMinorUnits: 1000,
        currency: 'USD',
        idempotencyKey: 'key-1',
      });

      expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: 'key-1' });
    });

    it('normalises the result and lets no Stripe field escape', async () => {
      create.mockResolvedValue(
        stripeIntent({
          id: 'pi_created',
          client_secret: 'pi_created_secret',
          amount: 2500,
          currency: 'usd',
          livemode: false,
          status: 'requires_payment_method',
        }),
      );

      const payment = await provider.createPayment({
        orderId: 'order-1',
        amountMinorUnits: 2500,
        currency: 'USD',
        idempotencyKey: 'key-1',
      });

      // toEqual, not toMatchObject: an extra key fails this.
      expect(payment).toEqual({
        providerPaymentId: 'pi_created',
        clientSecret: 'pi_created_secret',
        amountMinorUnits: 2500,
        currency: 'USD',
      });
    });

    it('rejects an intent with no client secret rather than returning null', async () => {
      create.mockResolvedValue(stripeIntent({ client_secret: null }));

      await expect(
        provider.createPayment({
          orderId: 'order-1',
          amountMinorUnits: 1000,
          currency: 'USD',
          idempotencyKey: 'key-1',
        }),
      ).rejects.toThrow('Payment intent has no client secret');
    });
  });

  describe('retrievePayment', () => {
    let retrieve: RetrieveMock;

    beforeEach(() => {
      retrieve = jest
        .fn<Promise<Stripe.PaymentIntent>, [string]>()
        .mockResolvedValue(stripeIntent());
      stripeOf(provider).paymentIntents.retrieve =
        retrieve as unknown as Stripe['paymentIntents']['retrieve'];
    });

    it('looks the payment up by provider id and normalises it', async () => {
      const payment = await provider.retrievePayment('pi_test_1');

      expect(retrieve).toHaveBeenCalledWith('pi_test_1');
      expect(payment).toEqual({
        providerPaymentId: 'pi_test_1',
        clientSecret: 'pi_test_1_secret',
        amountMinorUnits: 1000,
        currency: 'USD',
      });
    });

    // The port declares Promise<ProviderPayment> with NO not-found variant, and
    // FakePaymentProvider rejects. The real adapter must match, not widen it.
    it('rejects when the provider does not know the payment', async () => {
      retrieve.mockRejectedValue(new Error('No such payment_intent: pi_gone'));

      await expect(provider.retrievePayment('pi_gone')).rejects.toThrow();
    });
  });

  describe('verifyWebhook', () => {
    it('accepts a correctly signed payload and normalises it', () => {
      const payload = eventPayload();
      const event = provider.verifyWebhook(Buffer.from(payload), sign(payload));

      expect(event).toEqual({
        providerEventId: 'evt_test_1',
        type: SUPPORTED_EVENT_TYPE,
        providerPaymentId: 'pi_test_1',
        orderId: 'order-1',
        amountMinorUnits: 1000,
        // C8: Stripe sends `usd`; Order.currency is `USD`. A naive comparison
        // would fail on EVERY authentic event.
        currency: 'USD',
      });
    });

    // The signature covers the exact bytes, so a body that round-trips through
    // JSON.parse/stringify with different key order or spacing would fail. This
    // pins that the adapter hands the SDK the Buffer it was given.
    it('verifies the exact raw bytes, not a re-serialised body', () => {
      const payload = `{"id":"evt_test_1","type":"${SUPPORTED_EVENT_TYPE}","data":{"object":{"id":"pi_test_1","amount":1000,"currency":"usd","metadata":{"orderId":"order-1"}}}}`;
      const rawBody = Buffer.from(payload, 'utf8');
      const signature = sign(payload);

      expect(provider.verifyWebhook(rawBody, signature).orderId).toBe(
        'order-1',
      );

      const reserialised = Buffer.from(
        JSON.stringify(JSON.parse(payload)) + ' ',
        'utf8',
      );

      expect(() => provider.verifyWebhook(reserialised, signature)).toThrow(
        'Invalid webhook signature',
      );
    });

    it('rejects a tampered body', () => {
      const signature = sign(eventPayload());

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(eventPayload({ amount: 1 })),
          signature,
        ),
      ).toThrow('Invalid webhook signature');
    });

    it('rejects a signature made with a different secret', () => {
      const payload = eventPayload();

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(payload),
          sign(payload, undefined, 'whsec_other'),
        ),
      ).toThrow('Invalid webhook signature');
    });

    it('rejects a stale timestamp outside the tolerance window', () => {
      const payload = eventPayload();
      const stale = sign(
        payload,
        Math.floor(Date.now() / 1000) - WEBHOOK_TOLERANCE_SECONDS - 60,
      );

      expect(() => provider.verifyWebhook(Buffer.from(payload), stale)).toThrow(
        'Invalid webhook signature',
      );
    });

    it('rejects a malformed signature header', () => {
      const payload = eventPayload();

      expect(() =>
        provider.verifyWebhook(Buffer.from(payload), 't=1,v1=zzz'),
      ).toThrow('Invalid webhook signature');
    });

    it('rejects a missing signature header', () => {
      const payload = eventPayload();

      expect(() => provider.verifyWebhook(Buffer.from(payload), '')).toThrow(
        'Invalid webhook signature',
      );
    });

    // Never the SDK's own error: StripeSignatureVerificationError carries the
    // raw body and the signature header on the error object and in its message.
    it('never lets the raw body or the signature header escape on a refusal', () => {
      const payload = eventPayload();
      const signature = sign(payload, undefined, 'whsec_other');

      try {
        provider.verifyWebhook(Buffer.from(payload), signature);
        throw new Error('expected a refusal');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        expect(message).toBe('Invalid webhook signature');
        expect(JSON.stringify(error)).not.toContain('order-1');
        expect(JSON.stringify(error)).not.toContain(signature);
      }
    });

    it('rejects a signed event whose payment intent lacks an orderId', () => {
      const payload = eventPayload({ metadata: {} });

      expect(() =>
        provider.verifyWebhook(Buffer.from(payload), sign(payload)),
      ).toThrow('Event carries no usable payment intent');
    });

    // The adapter does NOT filter event types — normalising and letting the
    // caller decide is what keeps an acknowledgeable event from becoming an
    // endless provider retry (spec §8.5).
    it('normalises an unsupported event type instead of refusing it', () => {
      const payload = eventPayload(
        {},
        { type: 'payment_intent.payment_failed' },
      );
      const event = provider.verifyWebhook(Buffer.from(payload), sign(payload));

      expect(event.type).toBe('payment_intent.payment_failed');
      expect(event.orderId).toBe('order-1');
      expect(event.currency).toBe('USD');
    });
  });

  describe('amountLimits', () => {
    // The numbers are NOT restated here: AMOUNT_LIMITS is the one place they
    // live, and both adapters delegate to amountLimitsFor().
    it('returns the one shared constant, not a private copy', () => {
      expect(provider.amountLimits('USD')).toBe(AMOUNT_LIMITS.USD);
    });

    it('admits the exact lower and upper bounds', () => {
      const limits = provider.amountLimits('USD');

      expect(payable(limits, usdLimits().minMinorUnits)).toBe(true);
      expect(payable(limits, usdLimits().maxMinorUnits)).toBe(true);
    });

    it('refuses one minor unit outside each bound', () => {
      const limits = provider.amountLimits('USD');

      expect(payable(limits, usdLimits().minMinorUnits - 1)).toBe(false);
      expect(payable(limits, usdLimits().maxMinorUnits + 1)).toBe(false);
    });

    it('returns null for a currency that is not payable in Phase 4', () => {
      expect(provider.amountLimits('EUR')).toBeNull();
      expect(provider.amountLimits('usd')).toBeNull();
      expect(provider.amountLimits('')).toBeNull();
      expect(payable(provider.amountLimits('EUR'), 1000)).toBe(false);
    });
  });

  describe('the port boundary', () => {
    it('implements exactly the four port members and none of the forbidden ones', () => {
      // The annotation is the load-bearing half: this file fails to COMPILE if
      // the adapter stops satisfying the port.
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

    // A SOURCE-TEXT guard, and deliberately labelled as the weaker thing it is
    // — the same admission Task 2's timingSafeEqual tripwire carries. "No file
    // but this one imports stripe" is a property of the module graph, not of
    // any value a test can call, so there is no behavioural form of it. The
    // type-level half is real and lives in the port: ProviderPayment and
    // ProviderEvent name no Stripe type, so a leak would have to be a new
    // import somewhere else, which is exactly what this catches.
    it('is the only file under src/ that imports stripe', () => {
      const root = join(__dirname, '..', '..', '..');
      const offenders: string[] = [];

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);

          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith('.ts')) {
            if (/from '(stripe)(\/|')/.test(readFileSync(full, 'utf8'))) {
              offenders.push(relative(root, full).replace(/\\/g, '/'));
            }
          }
        }
      };

      walk(root);

      expect(offenders.sort()).toEqual([
        'modules/payments/provider/stripe-payment.provider.spec.ts',
        'modules/payments/provider/stripe-payment.provider.ts',
      ]);
    });
  });
});
