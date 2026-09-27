import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { envValidationSchema } from '../../config/env.validation';
import { createPaymentProvider } from './payments.module';
import { FakePaymentProvider } from './provider/fake-payment.provider';
import { StripePaymentProvider } from './provider/stripe-payment.provider';

function configFor(
  values: Record<string, unknown>,
): ConfigService<AppConfig, true> {
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService<AppConfig, true>;
}

describe('createPaymentProvider', () => {
  it('selects the fake adapter when the provider is fake', () => {
    const provider = createPaymentProvider(
      configFor({
        'payments.provider': 'fake',
        'payments.webhookSecret': 'w'.repeat(20),
      }),
    );

    expect(provider).toBeInstanceOf(FakePaymentProvider);
  });

  it('selects the Stripe adapter when the provider is stripe', () => {
    const provider = createPaymentProvider(
      configFor({
        'payments.provider': 'stripe',
        'payments.apiKey': 'sk_test_key',
        'payments.webhookSecret': 'whsec_test',
      }),
    );

    expect(provider).toBeInstanceOf(StripePaymentProvider);
  });

  /**
   * The behavioural witness that the selection is a TERNARY and not two eager
   * constructions: StripePaymentProvider's constructor throws when
   * PAYMENT_API_KEY is absent, which is the normal shape of a fake-provider
   * boot (CI has no Stripe credentials). Building both adapters and choosing
   * afterwards would therefore throw here instead of returning the fake.
   */
  it('never constructs the Stripe adapter when the fake is selected', () => {
    expect(
      createPaymentProvider(
        configFor({
          'payments.provider': 'fake',
          'payments.apiKey': undefined,
          'payments.webhookSecret': 'w'.repeat(20),
        }),
      ),
    ).toBeInstanceOf(FakePaymentProvider);
  });

  /**
   * The factory has no NODE_ENV branch, by design — a duplicated rule is a
   * second place to disagree with the first. This asserts the single place
   * that rule actually lives is still holding. Its edge cases (including why
   * Joi.override is load-bearing) are pinned in env.validation.spec.ts.
   */
  it('relies on boot validation, not itself, to keep the fake out of production', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_SECRET: 'j'.repeat(32),
      PAYMENT_WEBHOOK_SECRET: 'w'.repeat(20),
    };

    expect(
      envValidationSchema.validate({ ...base, PAYMENT_PROVIDER: 'fake' }).error,
    ).toBeDefined();
    expect(
      envValidationSchema.validate({
        ...base,
        PAYMENT_PROVIDER: 'stripe',
        PAYMENT_API_KEY: 'sk_live_key',
      }).error,
    ).toBeUndefined();
  });
});
