/**
 * The payment provider port.
 *
 * Four members, each with exactly one caller in Phase 4 (spec §6.2):
 *   createPayment   — initiation, first attempt only
 *   retrievePayment — initiation replay, whenever a Payment row exists
 *   verifyWebhook   — the webhook endpoint's only authentication
 *   amountLimits    — initiation, before createPayment; pure, no I/O
 *
 * Deliberately absent: confirmPayment (D11 — completion is out-of-band),
 * cancelPayment, refund, capture, void, listEvents, getCustomer. None has a
 * caller, and confirmPayment would put a second writer on the paid path
 * beside the webhook.
 *
 * NO METHOD TAKES A Prisma.TransactionClient. That absence is the point: it
 * is the inverse of the decrementStock(tx, …) convention. Where a required
 * `tx` proves a call must run INSIDE a transaction, its absence here
 * documents at the type level that a provider call can never be made from
 * inside one (spec §10).
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** The only event type that changes authoritative order state (D4). */
export const SUPPORTED_EVENT_TYPE = 'payment_intent.succeeded';

export interface CreatePaymentInput {
  orderId: string;
  amountMinorUnits: number;
  currency: string;
  idempotencyKey: string;
}

export interface ProviderPayment {
  providerPaymentId: string;
  clientSecret: string;
  amountMinorUnits: number;
  /** Uppercase ISO-4217. Adapters normalise; the domain never sees lowercase. */
  currency: string;
}

export interface ProviderEvent {
  providerEventId: string;
  type: string;
  providerPaymentId: string;
  orderId: string;
  amountMinorUnits: number;
  /** Uppercase ISO-4217, normalised by the adapter (spec §8.4, C8). */
  currency: string;
}

export interface AmountLimits {
  minMinorUnits: number;
  maxMinorUnits: number;
}

/**
 * The payable range, as a DOMAIN contract rather than an adapter detail —
 * which is why it lives in the port and both adapters return from it. A
 * future provider with different limits makes this per-adapter AT THAT TIME,
 * not speculatively now.
 *
 * Verified against Stripe's published tables on 2026-09-23 (spec §5.4.1,
 * https://docs.stripe.com/currencies -> "Minimum and maximum charge amounts"):
 *
 *   minimum   0.50 USD                                    -> 50
 *   maximum   12 digits for most card networks,
 *              9 digits for American Express,
 *              8 digits for non-card methods              -> 99_999_999
 *
 * The maximum is the LOWEST documented tier on purpose: the payment method is
 * unknown at initiation, so only a value below every tier produces a correct
 * refusal for all of them. The rule for ever changing these numbers: they
 * must stay AT OR INSIDE the provider's published range, never wider — a
 * conservative constant yields a clean 422, a too-wide one yields an opaque
 * provider rejection.
 *
 * A currency absent from this map is not payable in Phase 4 (422).
 *
 * The type is Partial<...>, NOT Record<string, AmountLimits>: this repo does
 * not set noUncheckedIndexedAccess, so a plain Record would type
 * AMOUNT_LIMITS['EUR'].minMinorUnits as a clean AmountLimits access and let it
 * compile — while throwing TypeError at runtime for every currency but USD.
 * Partial makes the indexed type AmountLimits | undefined, so the absent-
 * currency path (spec §5.4: null -> 422) cannot be skipped by accident.
 */
export const AMOUNT_LIMITS: Readonly<Partial<Record<string, AmountLimits>>> = {
  USD: { minMinorUnits: 50, maxMinorUnits: 99_999_999 },
};

export function amountLimitsFor(currency: string): AmountLimits | null {
  return AMOUNT_LIMITS[currency] ?? null;
}

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<ProviderPayment>;
  retrievePayment(providerPaymentId: string): Promise<ProviderPayment>;
  /** Throws on an invalid signature or an unusable payload. Never returns null. */
  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent;
  amountLimits(currency: string): AmountLimits | null;
}
