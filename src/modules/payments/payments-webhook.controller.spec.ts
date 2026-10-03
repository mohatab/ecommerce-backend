import { BadRequestException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { SUPPORTED_EVENT_TYPE } from './provider/payment-provider';
import type {
  PaymentProvider,
  ProviderEvent,
} from './provider/payment-provider';

const EVENT: ProviderEvent = {
  providerEventId: 'evt_1',
  type: SUPPORTED_EVENT_TYPE,
  providerPaymentId: 'pi_1',
  orderId: 'order-1',
  amountMinorUnits: 1000,
  currency: 'USD',
};

function requestWith(rawBody: Buffer | undefined): RawBodyRequest<Request> {
  return { rawBody } as unknown as RawBodyRequest<Request>;
}

describe('PaymentsWebhookController', () => {
  let controller: PaymentsWebhookController;
  let provider: {
    verifyWebhook: jest.Mock<ProviderEvent, [Buffer, string]>;
  };
  let webhookService: { apply: jest.Mock<Promise<void>, [ProviderEvent]> };

  /** `handle` is async, so a refusal is a REJECTION, never a sync throw. */
  const reject = (
    request: RawBodyRequest<Request>,
    signature: string | undefined,
  ): Promise<unknown> =>
    controller.handle(request, signature).then(
      () => null,
      (caught: unknown) => caught,
    );

  beforeEach(() => {
    provider = {
      verifyWebhook: jest
        .fn<ProviderEvent, [Buffer, string]>()
        .mockReturnValue(EVENT),
    };
    webhookService = {
      apply: jest
        .fn<Promise<void>, [ProviderEvent]>()
        .mockResolvedValue(undefined),
    };

    controller = new PaymentsWebhookController(
      provider as unknown as PaymentProvider,
      webhookService as unknown as PaymentWebhookService,
    );
  });

  it('verifies against the RAW bytes, not the parsed body', async () => {
    const raw = Buffer.from('{"a":1}');

    await controller.handle(requestWith(raw), 'sig');

    expect(provider.verifyWebhook).toHaveBeenCalledWith(raw, 'sig');
  });

  it('returns { received: true } for a supported event', async () => {
    await expect(
      controller.handle(requestWith(Buffer.from('{}')), 'sig'),
    ).resolves.toEqual({ received: true });
  });

  it('applies a supported event', async () => {
    await controller.handle(requestWith(Buffer.from('{}')), 'sig');

    expect(webhookService.apply).toHaveBeenCalledWith(EVENT);
  });

  /**
   * The event-type check is load-bearing, and from this task on it suppresses
   * a real write rather than only a log line: the adapters' field checks are
   * STRUCTURAL, not type discriminants, so a `charge.refunded` delivery
   * normalises into a well-formed ProviderEvent. Deleting the check makes
   * this assertion fail here, and the e2e control in
   * test/payments-webhook.e2e-spec.ts fail at the HTTP boundary.
   */
  it('does NOT apply an unsupported event type', async () => {
    provider.verifyWebhook.mockReturnValue({
      ...EVENT,
      type: 'charge.refunded',
    });

    await expect(
      controller.handle(requestWith(Buffer.from('{}')), 'sig'),
    ).resolves.toEqual({ received: true });
    expect(webhookService.apply).not.toHaveBeenCalled();
  });

  it('400s when the signature header is missing', async () => {
    await expect(
      reject(requestWith(Buffer.from('{}')), undefined),
    ).resolves.toBeInstanceOf(BadRequestException);
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
    expect(webhookService.apply).not.toHaveBeenCalled();
  });

  it('400s when verification throws', async () => {
    provider.verifyWebhook.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });

    await expect(
      reject(requestWith(Buffer.from('{}')), 'bad'),
    ).resolves.toBeInstanceOf(BadRequestException);
    expect(webhookService.apply).not.toHaveBeenCalled();
  });

  it('never leaks the provider’s verification message', async () => {
    provider.verifyWebhook.mockImplementation(() => {
      throw new Error('timestamp outside the tolerance zone');
    });

    const error = await reject(requestWith(Buffer.from('{}')), 'bad');

    expect(JSON.stringify(error)).not.toContain('tolerance');
  });

  // A misconfiguration that silently disabled signature checking on a money
  // endpoint is the worst outcome available in this phase, so it must be
  // LOUD: a 500, never a fallback to an empty buffer.
  it('throws a non-4xx error when rawBody is missing entirely', async () => {
    const error = await reject(requestWith(undefined), 'sig');

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/raw body/i);
    expect(error).not.toBeInstanceOf(BadRequestException);
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
    expect(webhookService.apply).not.toHaveBeenCalled();
  });

  // A database failure inside the transaction must reach the client as a 500,
  // never be swallowed into an ack: a 2xx would tell the provider the delivery
  // was handled and stop the retry that is the only recovery path.
  it('lets a database failure escape instead of acknowledging it', async () => {
    webhookService.apply.mockRejectedValue(new Error('connection terminated'));

    const error = await reject(requestWith(Buffer.from('{}')), 'sig');

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BadRequestException);
  });

  // The decorators carry two security properties that no in-process call to
  // handle() can exercise, so they are asserted as metadata. The @nestjs/
  // throttler package does not re-export its metadata key constants from its
  // entry point, hence the literals — they are `THROTTLER:LIMIT`/`:TTL`
  // suffixed with the throttler NAME, and `default` is the name
  // ThrottlerModule.forRoot assigns when none is given. Any other key would
  // be ignored silently, which is exactly the mistake this pins.
  describe('route metadata', () => {
    // Both decorators define their metadata on the handler FUNCTION, which is
    // where Reflect.getMetadata has to look. It is reached through an
    // `object`-typed view of the prototype rather than
    // `…prototype.handle`, because reading a method off a prototype is an
    // unbound-method reference and `lint:ci` rejects it — and .bind() is not
    // an option here, since it would produce a new function carrying none of
    // the metadata under test.
    const handler = (
      PaymentsWebhookController.prototype as unknown as Record<string, object>
    ).handle;

    it('is @Public() — without it every delivery would be 401', () => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    });

    it('raises the throttle to 300/min under the `default` key', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMIT' + 'default', handler)).toBe(
        300,
      );
      expect(Reflect.getMetadata('THROTTLER:TTL' + 'default', handler)).toBe(
        60_000,
      );
    });
  });
});
