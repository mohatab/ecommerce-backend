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
  ProviderPaymentNotFoundError,
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
 * AMOUNT_LIMITS is Partial<Record<...>> by design — an absent currency is not
 * payable — so even the one supported entry arrives as AmountLimits |
 * undefined and has to be narrowed once, here, rather than asserted away at
 * each use.
 */
function usdLimits(): AmountLimits {
  const limits = AMOUNT_LIMITS.USD;

  if (limits === undefined) {
    throw new Error('AMOUNT_LIMITS.USD must be defined');
  }

  return limits;
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

    // The mismatch control's lifetime is "the next createPayment CALL", not
    // "the next intent created" — so a retention replay consumes it and leaves
    // nothing armed. Reading it after the replay branch instead would make
    // this last create report 999.
    it('consumes the mismatch control on a retention replay, arming nothing', async () => {
      await provider.createPayment(input);

      provider.mismatchNextCreateAmount(999);

      const replay = await provider.createPayment(input);

      expect(replay.amountMinorUnits).toBe(1000);

      const later = await provider.createPayment({
        ...input,
        idempotencyKey: 'order-2',
      });

      expect(later.amountMinorUnits).toBe(1000);
    });

    // ProviderPayment.currency is documented "Uppercase ISO-4217. Adapters
    // normalise" — the fake must honour its own port's contract, not lean on
    // every caller happening to pass uppercase today.
    it('normalises the currency to uppercase', async () => {
      const created = await provider.createPayment({
        ...input,
        currency: 'usd',
      });

      expect(created.currency).toBe('USD');
      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toMatchObject({ currency: 'USD' });
    });

    it('hands back a copy, so a caller cannot mutate the fake state', async () => {
      const created = await provider.createPayment(input);

      created.amountMinorUnits = 1;
      created.clientSecret = 'leaked';

      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toMatchObject({
        amountMinorUnits: 1000,
        clientSecret: 'pi_fake_order-1_1_secret_1',
      });

      const replay = await provider.createPayment(input);

      expect(replay.amountMinorUnits).toBe(1000);

      // The retrieve path copies too.
      const retrieved = await provider.retrievePayment(
        created.providerPaymentId,
      );

      retrieved.amountMinorUnits = 2;

      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toMatchObject({ amountMinorUnits: 1000 });
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

    // Phase 5, spec §7.3: not-found is an ERROR, and it is a DISTINGUISHABLE
    // one. `rejects.toThrow(Error)` would pass for both this and
    // failNextRetrieve() below, so both assert the class.
    it('rejects with ProviderPaymentNotFoundError for an unknown id', async () => {
      await expect(provider.retrievePayment('pi_never_minted')).rejects.toThrow(
        ProviderPaymentNotFoundError,
      );
    });
  });

  describe('status (Phase 5)', () => {
    it('reports pending for a freshly created intent', async () => {
      const created = await provider.createPayment(input);

      expect(created.status).toBe('pending');
      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toMatchObject({ status: 'pending' });
    });

    it('reports succeeded once the test control marks it so', async () => {
      const created = await provider.createPayment(input);

      provider.markNextRetrieveSucceeded(created.providerPaymentId);

      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toMatchObject({ status: 'succeeded' });
    });

    it('rejects with a generic error when failNextRetrieve is armed', async () => {
      const created = await provider.createPayment(input);

      provider.failNextRetrieve();

      const error: unknown = await provider
        .retrievePayment(created.providerPaymentId)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      // The load-bearing half: an unreachable provider is NOT a not-found.
      expect(error).not.toBeInstanceOf(ProviderPaymentNotFoundError);
    });

    // notFoundNextRetrieve() is the mirror image: a KNOWN id the provider
    // claims not to recognise. Without it the only way to produce a not-found
    // is an id that was never minted, which cannot stand in for the
    // reconciliation case (§8) where a Payment row exists locally.
    it('rejects a known id with ProviderPaymentNotFoundError when notFoundNextRetrieve is armed', async () => {
      const created = await provider.createPayment(input);

      provider.notFoundNextRetrieve();

      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).rejects.toThrow(ProviderPaymentNotFoundError);

      // One-shot, like failNextCreate: the next call succeeds again.
      await expect(
        provider.retrievePayment(created.providerPaymentId),
      ).resolves.toMatchObject({ status: 'pending' });
    });
  });

  describe('verifyWebhook', () => {
    // WHAT THIS PROVES, EXACTLY: that the literal text "timingSafeEqual(" is
    // present in the provider source. Nothing more. It does NOT prove the call
    // is on the comparison path, that it is reached, or that the comparison is
    // constant-time — a comment containing that text satisfies it, and so does
    // a dead call beside a Buffer.equals. Treat it as a tripwire against a
    // wholesale deletion, never as a behavioural test.
    //
    // WHY IT IS THE BEST AVAILABLE: constant-time-ness is not observable from
    // a unit test. Swapping timingSafeEqual for Buffer.equals leaves every
    // behavioural test in this file green (recorded as a null result in the
    // task report); jest.spyOn(crypto, 'timingSafeEqual') throws "Cannot
    // redefine property" under ts-jest's CJS output; a wall-clock timing
    // assertion is flaky in a JIT and would not establish the property anyway.
    // Spec §6.4 names crypto.timingSafeEqual specifically, so the tripwire
    // stays despite being weak.
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
      const malformed = 'Malformed signature header';

      expect(() => provider.verifyWebhook(body, '')).toThrow(malformed);
      expect(() => provider.verifyWebhook(body, 'not-hex')).toThrow(malformed);
      expect(() => provider.verifyWebhook(body, 't=,v1=')).toThrow(malformed);
      expect(() => provider.verifyWebhook(body, 'v1=deadbeef')).toThrow(
        malformed,
      );
      expect(() =>
        provider.verifyWebhook(body, `t=${Math.floor(Date.now() / 1000)}`),
      ).toThrow(malformed);
    });

    // The header above parses: `t` is an integer and `v1` is lowercase hex, so
    // it reaches the digest comparison — with a 4-character digest against a
    // 64-character one. Without the length check in verifyWebhook,
    // timingSafeEqual throws RangeError('Input buffers must have the same byte
    // length') instead, which Task 5 would surface as an unmapped 500 where
    // spec §8.5 requires 400 "Invalid signature". Deleting the guard must fail
    // HERE, not in Task 5's e2e.
    it('rejects a well-formed header carrying a wrong-LENGTH digest', () => {
      const payload = eventPayload();
      const header = `t=${Math.floor(Date.now() / 1000)},v1=abcd`;

      expect(() =>
        provider.verifyWebhook(Buffer.from(payload), header),
      ).toThrow('Invalid signature');
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

    // Message-specific on purpose: a bare .toThrow() here passes on the RAW
    // SyntaxError that an unguarded JSON.parse produces, which certifies the
    // crash instead of the refusal — and that SyntaxError's message embeds a
    // prefix of the attacker-supplied body.
    it('rejects correctly signed non-JSON with the controlled refusal', () => {
      const payload = 'not json at all';

      expect(() =>
        provider.verifyWebhook(
          Buffer.from(payload),
          provider.signWebhook(payload),
        ),
      ).toThrow('Malformed event payload');
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

    // The type-level half of the same guarantee, and the only mechanical guard
    // on it: AMOUNT_LIMITS must be Partial<Record<...>>, so indexing it yields
    // AmountLimits | undefined and the absent-currency path cannot be skipped
    // by accident. Widening it back to Readonly<Record<string, AmountLimits>>
    // makes the line below compile, which turns the @ts-expect-error into an
    // unused-directive error — the negative control, verified. Note WHERE it
    // fires: `npx tsc --noEmit -p tsconfig.json`, not jest. tsconfig sets
    // isolatedModules, so ts-jest transpiles without type-checking, and
    // tsconfig.build.json excludes *.spec.ts from `npm run build`. The runtime
    // assertion is what jest can see; it shows what the widened type hides.
    it('makes an unsupported currency undefined at the type level too', () => {
      expect(AMOUNT_LIMITS.EUR).toBeUndefined();
      expect(
        // @ts-expect-error AMOUNT_LIMITS.EUR is possibly undefined
        () => AMOUNT_LIMITS.EUR.minMinorUnits,
      ).toThrow(TypeError);
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

  // In-memory state is not cleared by truncateAll(), so a control left armed
  // leaks into the next suite's first retrieval.
  it('reset() disarms the retrieve controls too', async () => {
    const created = await provider.createPayment(input);

    provider.markNextRetrieveSucceeded(created.providerPaymentId);
    provider.failNextRetrieve();
    provider.notFoundNextRetrieve();
    provider.reset();

    const recreated = await provider.createPayment(input);

    await expect(
      provider.retrievePayment(recreated.providerPaymentId),
    ).resolves.toMatchObject({ status: 'pending' });
  });
});
