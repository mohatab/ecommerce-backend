import { BadRequestException, Logger } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
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

  beforeEach(() => {
    provider = {
      verifyWebhook: jest
        .fn<ProviderEvent, [Buffer, string]>()
        .mockReturnValue(EVENT),
    };

    controller = new PaymentsWebhookController(
      provider as unknown as PaymentProvider,
    );
  });

  it('verifies against the RAW bytes, not the parsed body', () => {
    const raw = Buffer.from('{"a":1}');

    controller.handle(requestWith(raw), 'sig');

    expect(provider.verifyWebhook).toHaveBeenCalledWith(raw, 'sig');
  });

  it('returns { received: true } for a supported event', () => {
    expect(controller.handle(requestWith(Buffer.from('{}')), 'sig')).toEqual({
      received: true,
    });
  });

  it('acknowledges an unsupported event type without erroring', () => {
    provider.verifyWebhook.mockReturnValue({
      ...EVENT,
      type: 'payment_intent.payment_failed',
    });

    expect(controller.handle(requestWith(Buffer.from('{}')), 'sig')).toEqual({
      received: true,
    });
  });

  /**
   * The event-type check is load-bearing — the adapters' field checks are
   * structural, not type discriminants, so a `charge.refunded` delivery
   * normalises into a well-formed ProviderEvent and this comparison is the
   * only thing stopping it from reaching state application in Task 7.
   *
   * In Task 6 both branches return the same ack and write nothing, so the
   * debug log is the ONLY observable difference. Asserting it is what makes
   * deleting the check a test failure today rather than in Task 7.
   */
  it('takes the ignore branch for an unsupported type and not for the supported one', () => {
    const debug = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);

    try {
      controller.handle(requestWith(Buffer.from('{}')), 'sig');

      expect(debug).not.toHaveBeenCalled();

      provider.verifyWebhook.mockReturnValue({
        ...EVENT,
        type: 'charge.refunded',
      });

      controller.handle(requestWith(Buffer.from('{}')), 'sig');

      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('charge.refunded'),
      );
    } finally {
      debug.mockRestore();
    }
  });

  it('400s when the signature header is missing', () => {
    expect(() =>
      controller.handle(requestWith(Buffer.from('{}')), undefined),
    ).toThrow(BadRequestException);
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
  });

  it('400s when verification throws', () => {
    provider.verifyWebhook.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });

    expect(() =>
      controller.handle(requestWith(Buffer.from('{}')), 'bad'),
    ).toThrow(BadRequestException);
  });

  it('never leaks the provider’s verification message', () => {
    provider.verifyWebhook.mockImplementation(() => {
      throw new Error('timestamp outside the tolerance zone');
    });

    const error = (() => {
      try {
        controller.handle(requestWith(Buffer.from('{}')), 'bad');
      } catch (caught: unknown) {
        return caught;
      }

      return null;
    })();

    expect(JSON.stringify(error)).not.toContain('tolerance');
  });

  // A misconfiguration that silently disabled signature checking on a money
  // endpoint is the worst outcome available in this phase, so it must be
  // LOUD: a 500, never a fallback to an empty buffer.
  it('throws a non-4xx error when rawBody is missing entirely', () => {
    expect(() => controller.handle(requestWith(undefined), 'sig')).toThrow(
      /raw body/i,
    );

    const error = (() => {
      try {
        controller.handle(requestWith(undefined), 'sig');
      } catch (caught: unknown) {
        return caught;
      }

      return null;
    })();

    expect(error).not.toBeInstanceOf(BadRequestException);
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
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
