import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../../config/configuration';
import {
  AmountLimits,
  CreatePaymentInput,
  PaymentProvider,
  ProviderEvent,
  ProviderPayment,
  ProviderPaymentNotFoundError,
  amountLimitsFor,
} from './payment-provider';

/**
 * How far a webhook timestamp may be from now before the signature is
 * refused, in seconds. 300 is Stripe's own default tolerance.
 *
 * It is a constant, not configuration: spec §12.1 explicitly adds no
 * PAYMENT_WEBHOOK_TOLERANCE_SECONDS variable, and the Stripe adapter leaves
 * the SDK default in place for the same reason — there is no evidence yet
 * that any other value is right, and a knob nobody turns is a knob nobody
 * tests. Exported so tests build stale headers from it instead of copying
 * the number.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * A REAL, DI-selected implementation — not a test double, and not in test/.
 *
 * It exists because CI has no provider credentials, e2e must run offline
 * against real Postgres, and every concurrency claim needs a recorded
 * negative control. Selecting it through configuration means e2e boots the
 * real AppModule with real wiring rather than an overrideProvider() mock —
 * which matters in this repo, where overrideGuard() is documented as a silent
 * no-op against APP_GUARD registrations.
 *
 * Its verifier is deliberately shaped like Stripe's, because a fake that is a
 * WEAKER verifier than the thing it stands in for makes the e2e suite prove
 * nothing about the shape of the real path (spec §6.4). So:
 *   - the header carries a timestamp and a digest, `t=<unix>,v1=<hex>`;
 *   - the signed material is `<timestamp>.<raw body bytes>`, so moving either
 *     the timestamp or one byte of the body invalidates it;
 *   - the digest is compared in CONSTANT TIME (crypto.timingSafeEqual);
 *   - a timestamp outside WEBHOOK_TOLERANCE_SECONDS is refused even when the
 *     digest is perfect.
 *
 * It is never selectable in production: Joi rejects PAYMENT_PROVIDER=fake
 * under NODE_ENV=production at boot (src/config/env.validation.ts).
 *
 * In-memory state is NOT cleared by truncateAll(). Every suite that uses the
 * test controls must call reset() in beforeEach.
 *
 * No method takes a Prisma.TransactionClient, and none may ever gain one —
 * see the port's header comment.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  private readonly webhookSecret: string;

  /** providerPaymentId -> the payment, for retrievePayment (never expires). */
  private readonly intents = new Map<string, ProviderPayment>();

  /** idempotencyKey -> providerPaymentId, pruned by expireIdempotencyKeys(). */
  private readonly retention = new Map<string, string>();

  /** idempotencyKey -> how many intents this provider actually created. */
  private readonly createCounts = new Map<string, number>();

  private sequence = 0;
  private nextCreateFailure: Error | null = null;
  private nextCreateAmount: number | null = null;

  /** providerPaymentIds that retrievePayment reports as 'succeeded'. */
  private readonly succeededIds = new Set<string>();

  private failRetrieve = false;
  private notFoundRetrieve = false;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.webhookSecret = configService.get('payments.webhookSecret', {
      infer: true,
    });
  }

  // Not `async`: the fake performs no I/O, so there is nothing to await and
  // the keyword would only be decoration. The port's Promise return type is
  // what callers contract against.
  createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    if (this.nextCreateFailure !== null) {
      const failure = this.nextCreateFailure;

      this.nextCreateFailure = null;

      // R3: ONE failure mechanism. A timeout and an outage are the same thing
      // to every caller of this port — a rejected promise — and nothing in
      // Phase 4 branches on which one it was, so the two are indistinguishable
      // here by design. Tests express the difference by passing a different
      // error; there is deliberately no separate timeout knob and no
      // fault-injection framework.
      return Promise.reject(failure);
    }

    // R2 (spec §6.4): the provider may report an amount that disagrees with
    // the one requested. This is the control the webhook's amount check and
    // its 502/mismatch paths are tested against.
    //
    // Consumed HERE, before the retention lookup, so its lifetime is exactly
    // "the next createPayment call" — the same lifetime as nextCreateFailure
    // above. Reading it after the replay branch would leave it armed when the
    // next call happened to be a replay, and fire it on a later, unrelated
    // create.
    const mismatchedAmount = this.nextCreateAmount;

    this.nextCreateAmount = null;

    const existingId = this.retention.get(input.idempotencyKey);

    if (existingId !== undefined) {
      // Within the retention window the provider returns the SAME payment —
      // this is what makes concurrent initiation produce exactly one intent.
      // A copy, so a caller mutating the result cannot corrupt the fake.
      return Promise.resolve({ ...this.intents.get(existingId)! });
    }

    const amountMinorUnits = mismatchedAmount ?? input.amountMinorUnits;

    this.sequence += 1;

    const providerPaymentId = `pi_fake_${input.orderId}_${this.sequence}`;
    const payment: ProviderPayment = {
      providerPaymentId,
      clientSecret: `${providerPaymentId}_secret_${this.sequence}`,
      amountMinorUnits,
      // ProviderPayment.currency is documented "Uppercase ISO-4217. Adapters
      // normalise" — so the fake normalises, rather than relying on every
      // caller already passing uppercase (C8, inbound side of the same rule).
      currency: input.currency.toUpperCase(),
      // A freshly created intent has not succeeded. A statement about our own
      // call, not a claim about the provider (spec §7.4).
      status: 'pending',
    };

    this.intents.set(providerPaymentId, payment);
    this.retention.set(input.idempotencyKey, providerPaymentId);
    this.createCounts.set(
      input.idempotencyKey,
      (this.createCounts.get(input.idempotencyKey) ?? 0) + 1,
    );

    return Promise.resolve({ ...payment });
  }

  retrievePayment(providerPaymentId: string): Promise<ProviderPayment> {
    // Armed before the lookup, and one-shot, exactly like nextCreateFailure:
    // "the provider is unreachable" is independent of whether this id exists.
    if (this.failRetrieve) {
      this.failRetrieve = false;

      return Promise.reject(new Error('Provider unreachable'));
    }

    // A KNOWN id the provider claims not to recognise — the §7.3 case that an
    // unminted id cannot stand in for, because a local Payment row exists.
    if (this.notFoundRetrieve) {
      this.notFoundRetrieve = false;

      return Promise.reject(
        new ProviderPaymentNotFoundError(providerPaymentId),
      );
    }

    const payment = this.intents.get(providerPaymentId);

    if (payment === undefined) {
      // Not a generic Error: not-found is a DISTINGUISHABLE rejection (spec
      // §7.3), and this is the window that makes Phase 4's 502 path exist.
      return Promise.reject(
        new ProviderPaymentNotFoundError(providerPaymentId),
      );
    }

    // A copy: ProviderPayment has no readonly members, so handing back the
    // stored object would let a caller mutate the fake's state and corrupt
    // every later retrieval of the same intent.
    return Promise.resolve({
      ...payment,
      status: this.succeededIds.has(providerPaymentId)
        ? 'succeeded'
        : payment.status,
    });
  }

  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent {
    const { timestamp, digest } = parseSignatureHeader(signature);

    const expected = Buffer.from(this.sign(timestamp, rawBody), 'utf8');
    const actual = Buffer.from(digest, 'utf8');

    // Length is compared first: timingSafeEqual throws RangeError on a length
    // mismatch, and a short-digest header is attacker-trivial (`v1=abcd`), so
    // without this the refusal spec §8.5 requires to be a 400 would surface as
    // an unmapped 500. Pinned by the wrong-length test in the spec file.
    // The digest covers the timestamp too, so a moved timestamp lands here
    // rather than in the tolerance check below.
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error('Invalid signature');
    }

    // Symmetric window: Stripe only refuses STALE timestamps, this refuses
    // future ones too. Stricter than the real verifier is safe; weaker is not.
    if (
      Math.abs(Math.floor(Date.now() / 1000) - timestamp) >
      WEBHOOK_TOLERANCE_SECONDS
    ) {
      throw new Error('Webhook timestamp outside tolerance');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // Never let Node's SyntaxError escape: its message embeds a prefix of
      // the attacker-supplied body, and every other refusal in this method is
      // a controlled Error the webhook route maps to 400 (spec §8.5).
      throw new Error('Malformed event payload');
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Malformed event payload');
    }

    const event = parsed as Record<string, unknown>;

    if (
      typeof event.id !== 'string' ||
      typeof event.type !== 'string' ||
      typeof event.providerPaymentId !== 'string' ||
      typeof event.orderId !== 'string' ||
      typeof event.amountMinorUnits !== 'number' ||
      typeof event.currency !== 'string'
    ) {
      throw new Error('Malformed event payload');
    }

    return {
      providerEventId: event.id,
      type: event.type,
      providerPaymentId: event.providerPaymentId,
      orderId: event.orderId,
      amountMinorUnits: event.amountMinorUnits,
      // Normalised here, exactly as the Stripe adapter does (C8).
      currency: event.currency.toUpperCase(),
    };
  }

  amountLimits(currency: string): AmountLimits | null {
    return amountLimitsFor(currency);
  }

  // ---- test controls -------------------------------------------------
  // Deliberately small. The fake simulates the provider BEHAVIOURS the design
  // depends on and nothing else: it is not a Stripe emulator. An unknown order
  // or an unsupported event type is expressed by the test signing whatever
  // payload it wants — no provider knob is needed for either.

  /**
   * Produces a valid signature header for a payload.
   *
   * `timestampSeconds` exists so a test can build a STALE header without
   * waiting on a real clock, mirroring Stripe's own
   * generateTestHeaderString({ payload, secret, timestamp }).
   */
  signWebhook(payload: string, timestampSeconds?: number): string {
    const timestamp = timestampSeconds ?? Math.floor(Date.now() / 1000);

    return `t=${timestamp},v1=${this.sign(
      timestamp,
      Buffer.from(payload, 'utf8'),
    )}`;
  }

  /** How many intents were actually created for a key (P3, I1). */
  createCountFor(idempotencyKey: string): number {
    return this.createCounts.get(idempotencyKey) ?? 0;
  }

  /** Simulates the provider pruning its idempotency keys (C3, I1). */
  expireIdempotencyKeys(): void {
    this.retention.clear();
  }

  /** The next createPayment rejects. A timeout is the same to the caller. */
  failNextCreate(error: string | Error): void {
    this.nextCreateFailure =
      typeof error === 'string' ? new Error(error) : error;
  }

  /**
   * The next createPayment reports this amount instead of the one asked for.
   *
   * One-shot with the same lifetime as failNextCreate: consumed by the next
   * call whether or not that call creates an intent, so a retention replay
   * cannot leave it armed.
   */
  mismatchNextCreateAmount(amountMinorUnits: number): void {
    this.nextCreateAmount = amountMinorUnits;
  }

  /** The next retrievePayment rejects. A timeout is the same to the caller. */
  failNextRetrieve(): void {
    this.failRetrieve = true;
  }

  /**
   * The next retrievePayment rejects with ProviderPaymentNotFoundError even
   * for an id this provider minted — the "provider lost it" case, which is a
   * different finding from an unreachable provider (spec §7.3).
   */
  notFoundNextRetrieve(): void {
    this.notFoundRetrieve = true;
  }

  /**
   * Marks an intent succeeded for subsequent retrievals.
   *
   * NOT one-shot, unlike the two above: "this payment succeeded" is a
   * persistent fact about the intent, and a sweep that retrieves it twice must
   * get the same answer both times.
   */
  markNextRetrieveSucceeded(providerPaymentId: string): void {
    this.succeededIds.add(providerPaymentId);
  }

  reset(): void {
    this.intents.clear();
    this.retention.clear();
    this.createCounts.clear();
    this.sequence = 0;
    this.nextCreateFailure = null;
    this.nextCreateAmount = null;
    this.succeededIds.clear();
    this.failRetrieve = false;
    this.notFoundRetrieve = false;
  }

  /** HMAC over `<timestamp>.<raw bytes>` — binds both, like Stripe's v1. */
  private sign(timestamp: number, rawBody: Buffer): string {
    return createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
  }
}

/** Parses `t=<unix seconds>,v1=<hex digest>`. Throws on anything else. */
function parseSignatureHeader(signature: string): {
  timestamp: number;
  digest: string;
} {
  const fields = new Map<string, string>();

  for (const part of signature.split(',')) {
    const separator = part.indexOf('=');

    if (separator > 0) {
      fields.set(part.slice(0, separator), part.slice(separator + 1));
    }
  }

  const rawTimestamp = fields.get('t');
  const digest = fields.get('v1');

  if (
    rawTimestamp === undefined ||
    !/^\d+$/.test(rawTimestamp) ||
    digest === undefined ||
    !/^[0-9a-f]+$/.test(digest)
  ) {
    throw new Error('Malformed signature header');
  }

  return { timestamp: Number(rawTimestamp), digest };
}
