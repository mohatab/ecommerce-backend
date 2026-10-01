import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { PAYMENT_PROVIDER, PaymentProvider } from './provider/payment-provider';
import { FakePaymentProvider } from './provider/fake-payment.provider';
import { StripePaymentProvider } from './provider/stripe-payment.provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Selection is by configuration, so the e2e suite boots the real AppModule
 * with real wiring rather than an overrideProvider() double (spec §6.1).
 *
 * The ternary is load-bearing: only the selected adapter is CONSTRUCTED.
 * Building both and picking one would run StripePaymentProvider's constructor
 * — and its PAYMENT_API_KEY requirement — on every fake-provider boot, which
 * is every CI run.
 *
 * There is deliberately NO second production guard here: Joi already rejects
 * PAYMENT_PROVIDER=fake under NODE_ENV=production at boot
 * (src/config/env.validation.ts), and a duplicated rule is a second place to
 * disagree with the first.
 */
export function createPaymentProvider(
  configService: ConfigService<AppConfig, true>,
): PaymentProvider {
  return configService.get('payments.provider', { infer: true }) === 'stripe'
    ? new StripePaymentProvider(configService)
    : new FakePaymentProvider(configService);
}

// PrismaModule is @Global, so PrismaService needs no import here. Nothing
// else is imported: initiation touches only orders and payments, never carts
// or stock, and it never writes the orders table.
@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: createPaymentProvider,
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
