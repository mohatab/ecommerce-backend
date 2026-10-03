import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import {
  PAYMENT_PROVIDER,
  SUPPORTED_EVENT_TYPE,
} from './provider/payment-provider';
// Type-only, and it must stay that way — the same TS1272 that
// payments.service.ts documents: `isolatedModules` plus the
// `emitDecoratorMetadata` Nest requires makes an INTERFACE used as the type of
// a decorated constructor parameter an error, because the emitted
// design:paramtypes would reference a binding that erases to nothing.
// PAYMENT_PROVIDER and SUPPORTED_EVENT_TYPE above are real values (a Symbol
// and a string), so they stay ordinary imports.
import type {
  PaymentProvider,
  ProviderEvent,
} from './provider/payment-provider';

export interface WebhookAck {
  received: true;
}

/**
 * The webhook lives in its OWN controller, separate from PaymentsController,
 * for the same reason admin-products.controller.ts is split from
 * products.controller.ts: ONE TRUST POSTURE PER CLASS (C7). Everything here is
 * @Public(); everything there is bearer-authenticated. Mixing them would put
 * @Public() one careless copy-paste away from a money endpoint that must
 * never be public.
 *
 * No PrismaService is injected here, and none may be: this task is the trust
 * boundary only, and that absence is the cleanest proof it performs no
 * database writes.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * @Public() is MANDATORY: the provider sends no bearer token, JwtAuthGuard
   * is global and fails closed, and without this every delivery is 401 and no
   * order ever becomes paid. Authentication here IS the signature.
   *
   * The raised throttle (D8, C5) rather than @SkipThrottle(): every delivery
   * arrives from one provider's small IP set, so the global 100/min per
   * handler per IP would throttle legitimate bursts — but skipping entirely
   * would leave an unauthenticated endpoint doing HMAC and database work with
   * no protection at all. The key MUST be `default`: that is the name
   * ThrottlerModule.forRoot assigns when none is given, and any other key is
   * ignored SILENTLY.
   *
   * This endpoint does not close the open trusted-proxy limitation in
   * docs/deferred-limitations.md; it sits inside its blast radius.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Payment provider webhook',
    description:
      'Signature-verified. This is the ONLY path that marks an order paid. ' +
      'Returns 200 for every authentic delivery it understands, including ' +
      'ones it deliberately does not act on, so the provider stops retrying; ' +
      'only an invalid signature or an unusable payload is 4xx.',
  })
  @ApiResponse({ status: 200, description: 'Delivery acknowledged' })
  @ApiResponse({
    status: 400,
    description: 'Invalid signature, or an unusable payload',
  })
  handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): WebhookAck {
    const event = this.verify(request, signature);

    // LOAD-BEARING, not belt-and-braces. The adapters' field checks are
    // STRUCTURAL, not type discriminants: a `charge.refunded` delivery
    // normalises into a perfectly well-formed ProviderEvent carrying a `ch_…`
    // id. This caller-side comparison is the ONLY thing standing between a
    // non-payment-intent event and state application.
    //
    // D4: exactly one event type changes authoritative state. Everything else
    // is acknowledged and NOT persisted — a 4xx here would tell the provider
    // to stop sending a category of event we may want later.
    if (event.type !== SUPPORTED_EVENT_TYPE) {
      this.logger.debug(`Ignoring unsupported event type ${event.type}`);

      return { received: true };
    }

    // Task 7 applies state here.
    return { received: true };
  }

  private verify(
    request: RawBodyRequest<Request>,
    signature: string | undefined,
  ): ProviderEvent {
    const rawBody = request.rawBody;

    if (rawBody === undefined) {
      // NOT a BadRequestException. An absent raw body means the application
      // was constructed without NEST_APP_OPTIONS, i.e. signature verification
      // is structurally impossible. That is a server misconfiguration and
      // must be a loud, logged 500 — never a fallback to an empty buffer, and
      // never a skipped check.
      throw new Error(
        'Request raw body is unavailable: the application was constructed ' +
          'without rawBody support (see NEST_APP_OPTIONS in src/bootstrap.ts)',
      );
    }

    if (signature === undefined || signature === '') {
      throw new BadRequestException('Invalid signature');
    }

    try {
      return this.provider.verifyWebhook(rawBody, signature);
    } catch (error: unknown) {
      // Logged, never returned: "timestamp too old" versus "digest mismatch"
      // tells an attacker which half to fix. The client sees one bare message.
      this.logger.warn(
        `Rejected webhook delivery: ${error instanceof Error ? error.message : 'unknown error'}`,
      );

      throw new BadRequestException('Invalid signature');
    }
  }
}
