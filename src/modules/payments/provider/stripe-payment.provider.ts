import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { AppConfig } from '../../../config/configuration';
import {
  AmountLimits,
  CreatePaymentInput,
  PaymentProvider,
  ProviderEvent,
  ProviderPayment,
  amountLimitsFor,
} from './payment-provider';

/**
 * Pinned explicitly (D10). The SDK types this field as
 * `LatestApiVersion = typeof ApiVersion`, so NO OTHER STRING COMPILES — an SDK
 * upgrade that moves the API version becomes a build error rather than a
 * silent change in event payload shapes. The assignment inside the
 * constructor below is what enforces it; the constant alone would not.
 *
 * Relying on the Stripe account's default API version is forbidden: that
 * default can be changed from a dashboard by someone who has never seen this
 * repository, and payload shapes would shift under a running deployment.
 *
 * Measured, so the claim is not overstated: in stripe@22.6.2 OMITTING the
 * option is not observably different — the SDK falls back to its own
 * `ApiVersion` constant, which is this same string, not to the account
 * default. So the pin's proven mechanism is the compile error on a WRONG
 * string, not a runtime difference from leaving it out.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;

/**
 * The real adapter. Thin by contract: normalise in, normalise out, no
 * business logic, no database, no transaction client (see the port's header).
 *
 * NOTHING OUTSIDE THIS FILE IMPORTS `stripe`. `ProviderPayment` and
 * `ProviderEvent` are the boundary, so no Stripe type reaches a service, a
 * controller or a DTO.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.webhookSecret = configService.get('payments.webhookSecret', {
      infer: true,
    });

    const apiKey = configService.get('payments.apiKey', { infer: true });

    // Joi requires PAYMENT_API_KEY whenever PAYMENT_PROVIDER=stripe, but that
    // is exactly the reasoning `requireEnv` in src/config/configuration.ts
    // exists to refuse: Joi guarding the boot path is not the same as this
    // class being safe, and the paths Joi does not run — a script importing
    // the factory directly, a future `ignoreEnvVars` — are where a fallback
    // would bite. `new Stripe('')` does NOT fail; it constructs happily and
    // then fails on the first request with an opaque authentication error,
    // far from the misconfiguration that caused it. So it throws here.
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'PAYMENT_API_KEY is not set. The Stripe payment provider has no ' +
          'default: refusing to construct rather than build a client with an ' +
          'empty key.',
      );
    }

    this.stripe = new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION });
  }

  async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinorUnits,
        // Stripe expects a lowercase code; the domain holds uppercase (C8).
        currency: input.currency.toLowerCase(),
        // The webhook resolves the order from THIS value, which arrives inside
        // the signed event — never from a local lookup that may not have
        // committed yet (spec §7.4 case 7, S5).
        metadata: { orderId: input.orderId },
      },
      // Deduplicates concurrent creates inside the provider's retention
      // window. Retention is bounded, which is exactly why the local Payment
      // row — not this key — is the durable guarantee (C3).
      { idempotencyKey: input.idempotencyKey },
    );

    return toProviderPayment(intent);
  }

  async retrievePayment(providerPaymentId: string): Promise<ProviderPayment> {
    // Lookup by id, with no idempotency-key retention involved — that is the
    // whole point of this member (spec §6.2, C3). An unknown id rejects,
    // because the port declares Promise<ProviderPayment> with no not-found
    // variant and FakePaymentProvider rejects too.
    return toProviderPayment(
      await this.stripe.paymentIntents.retrieve(providerPaymentId),
    );
  }

  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent {
    let event: Stripe.Event;

    try {
      // Exact raw bytes, the incoming header, and the configured secret.
      // `tolerance` is deliberately NOT passed: spec §6.3 leaves it at the
      // SDK default (300s, the value FakePaymentProvider mirrors), and Phase 4
      // adds no configuration knob for it.
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch {
      // Stripe's StripeSignatureVerificationError carries the raw body and the
      // signature header on the error object and in its message. Re-throwing a
      // controlled Error keeps both out of anything that later logs or
      // serialises it — the same rule FakePaymentProvider applies to Node's
      // SyntaxError.
      throw new Error('Invalid webhook signature');
    }

    // The event type is NOT filtered here. An unsupported type normalises like
    // any other and the caller decides what to do with it (spec §8.5); an
    // adapter that threw would turn an acknowledgeable event into an endless
    // provider retry.
    const intent = event.data.object as Stripe.PaymentIntent;
    const orderId = intent.metadata?.orderId;

    // Every field below is returned as a non-optional member of ProviderEvent,
    // so each is checked rather than trusted: `data.object` is only a
    // PaymentIntent for payment-intent events, and returning `undefined` typed
    // as `number` would push the lie downstream.
    if (
      typeof intent.id !== 'string' ||
      typeof intent.amount !== 'number' ||
      typeof intent.currency !== 'string' ||
      typeof orderId !== 'string' ||
      orderId === ''
    ) {
      throw new Error('Event carries no usable payment intent');
    }

    return {
      providerEventId: event.id,
      type: event.type,
      providerPaymentId: intent.id,
      orderId,
      amountMinorUnits: intent.amount,
      // Stripe sends `usd`; Order.currency is `USD` (C8, spec §8.4).
      currency: intent.currency.toUpperCase(),
    };
  }

  amountLimits(currency: string): AmountLimits | null {
    // Delegated, never restated: the payable range is a DOMAIN contract that
    // lives in the port, and both adapters return from it.
    return amountLimitsFor(currency);
  }
}

/**
 * The one place a Stripe type becomes a domain type. Not a method: it needs no
 * instance state, and the adapter's public surface is exactly the port's four
 * members.
 */
function toProviderPayment(intent: Stripe.PaymentIntent): ProviderPayment {
  if (intent.client_secret === null) {
    throw new Error('Payment intent has no client secret');
  }

  return {
    providerPaymentId: intent.id,
    clientSecret: intent.client_secret,
    amountMinorUnits: intent.amount,
    // Uppercase on the way out too — the domain never sees lowercase (C8).
    currency: intent.currency.toUpperCase(),
  };
}
