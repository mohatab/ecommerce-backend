import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

// Mirrors what ConfigModule actually applies at boot. `app.module.ts` passes
// `{ abortEarly: false }`, and @nestjs/config fills in `allowUnknown: true`
// whenever it is left undefined. Pinning both here means this test and the
// runtime cannot drift apart.
const VALIDATION_OPTIONS = { abortEarly: false, allowUnknown: true };

interface ValidatedEnv {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  CORS_ORIGIN: string;
  TEST_DATABASE_URL?: string;
  JWT_SECRET: string;
  JWT_ACCESS_TTL: string;
  JWT_REFRESH_TTL: string;
  PAYMENT_PROVIDER: string;
  PAYMENT_API_KEY?: string;
  PAYMENT_WEBHOOK_SECRET: string;
  MAINTENANCE_JOBS_ENABLED: boolean;
  TRUST_PROXY_HOPS: number;
}

function validate(env: Record<string, unknown>): {
  error: ValidationError | undefined;
  value: ValidatedEnv;
} {
  const result = envValidationSchema.validate(env, VALIDATION_OPTIONS);

  return { error: result.error, value: result.value as ValidatedEnv };
}

/** The smallest environment that boots. Every other variable has a default. */
function validEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/ecommerce_dev',
    JWT_SECRET: 'x'.repeat(32),
    PAYMENT_PROVIDER: 'fake',
    PAYMENT_WEBHOOK_SECRET: 'y'.repeat(20),
    ...overrides,
  };
}

/**
 * The smallest environment that boots under NODE_ENV=production.
 *
 * Production has strictly MORE required variables than development, because
 * three guards have no safe default there (spec section 7). Keeping that
 * difference in one helper is what stops every production test from drifting
 * its own ad-hoc variable list.
 */
function validProdEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return validEnv({
    NODE_ENV: 'production',
    PAYMENT_PROVIDER: 'stripe',
    PAYMENT_API_KEY: 'sk_test_example',
    TRUST_PROXY_HOPS: 0,
    ...overrides,
  });
}

function rejectedKeys(error: ValidationError | undefined): string[] {
  return (error?.details ?? []).map((detail) => String(detail.path[0]));
}

describe('envValidationSchema', () => {
  describe('accepting a valid environment', () => {
    it('accepts the minimal environment', () => {
      expect(validate(validEnv()).error).toBeUndefined();
    });

    it('applies defaults for every optional variable', () => {
      const { value } = validate(validEnv());

      expect(value.NODE_ENV).toBe('development');
      expect(value.PORT).toBe(3000);
      expect(value.CORS_ORIGIN).toBe('*');
    });

    it('coerces a numeric-string PORT to a number', () => {
      const { error, value } = validate(validEnv({ PORT: '8080' }));

      expect(error).toBeUndefined();
      expect(value.PORT).toBe(8080);
      expect(typeof value.PORT).toBe('number');
    });

    it('ignores unrelated process environment variables', () => {
      // The schema validates the whole of process.env, so it must tolerate
      // PATH, HOME and everything else the OS supplies. A schema that rejected
      // unknown keys would abort boot on every machine.
      const { error } = validate(
        validEnv({ PATH: '/usr/bin', HOME: '/home/app', SHLVL: '1' }),
      );

      expect(error).toBeUndefined();
    });

    it('accepts a JWT_SECRET at exactly the floor', () => {
      expect(
        validate(validEnv({ JWT_SECRET: 'a'.repeat(32) })).error,
      ).toBeUndefined();
    });

    it('defaults the token lifetimes', () => {
      const { value } = validate(validEnv());

      expect(value.JWT_ACCESS_TTL).toBe('15m');
      expect(value.JWT_REFRESH_TTL).toBe('7d');
    });
  });

  describe('failing fast on a broken environment', () => {
    it('rejects a missing DATABASE_URL', () => {
      const { error } = validate({});

      expect(error).toBeDefined();
      expect(rejectedKeys(error)).toContain('DATABASE_URL');
    });

    it('rejects a DATABASE_URL that is not a URI', () => {
      const { error } = validate(validEnv({ DATABASE_URL: 'not-a-database' }));

      expect(rejectedKeys(error)).toContain('DATABASE_URL');
    });

    it('rejects an unrecognised NODE_ENV', () => {
      const { error } = validate(validEnv({ NODE_ENV: 'staging' }));

      expect(rejectedKeys(error)).toContain('NODE_ENV');
    });

    it('rejects a PORT outside the valid range', () => {
      expect(
        rejectedKeys(validate(validEnv({ PORT: '70000' })).error),
      ).toContain('PORT');
      expect(rejectedKeys(validate(validEnv({ PORT: 'abc' })).error)).toContain(
        'PORT',
      );
    });

    it('rejects a missing JWT_SECRET', () => {
      const env = validEnv();
      delete env.JWT_SECRET;

      expect(rejectedKeys(validate(env).error)).toContain('JWT_SECRET');
    });

    it('rejects a JWT_SECRET below the 32-character floor', () => {
      const { error } = validate(validEnv({ JWT_SECRET: 'a'.repeat(31) }));

      expect(rejectedKeys(error)).toContain('JWT_SECRET');
    });

    it('reports every problem at once rather than stopping at the first', () => {
      // abortEarly: false is what makes a misconfigured deploy fixable in one
      // pass instead of one variable per restart.
      const { error } = validate({ NODE_ENV: 'staging', PORT: '70000' });

      expect(rejectedKeys(error)).toEqual(
        expect.arrayContaining(['NODE_ENV', 'PORT', 'DATABASE_URL']),
      );
    });
  });

  describe('JWT TTL format', () => {
    // Before this validation existed, `JWT_REFRESH_TTL="fifteen"` passed Joi,
    // booted a clean-looking app, and then threw out of
    // TokenService.parseDurationMs on the first register or login — a config
    // typo surfacing as a 500 at runtime instead of at boot.
    const ttlVars = ['JWT_ACCESS_TTL', 'JWT_REFRESH_TTL'] as const;

    describe.each(ttlVars)('%s', (variable) => {
      it.each(['15m', '7d', '3600s', '24h', '1m'])(
        'accepts %s',
        (value: string) => {
          const { error } = validate(validEnv({ [variable]: value }));

          expect(error).toBeUndefined();
        },
      );

      it.each(['fifteen', '15 minutes', '1x', '', 'm15', '15', '1.5h', '-5m'])(
        'rejects %p',
        (value: string) => {
          const { error } = validate(validEnv({ [variable]: value }));

          expect(rejectedKeys(error)).toContain(variable);
        },
      );
    });

    it('keeps the documented defaults when unset', () => {
      const { value } = validate(validEnv());

      expect(value.JWT_ACCESS_TTL).toBe('15m');
      expect(value.JWT_REFRESH_TTL).toBe('7d');
    });
  });

  describe('TEST_DATABASE_URL', () => {
    it('is optional, so production boots without it', () => {
      expect(validate(validEnv()).error).toBeUndefined();
    });

    it('must still be a URI when supplied', () => {
      const { error } = validate(validEnv({ TEST_DATABASE_URL: 'nonsense' }));

      expect(rejectedKeys(error)).toContain('TEST_DATABASE_URL');
    });
  });

  describe('admin bootstrap credentials', () => {
    it('accepts an environment with no admin bootstrap variables', () => {
      expect(validate(validEnv()).error).toBeUndefined();
    });

    it('rejects a malformed ADMIN_EMAIL', () => {
      const { error } = validate(validEnv({ ADMIN_EMAIL: 'not-an-email' }));

      expect(rejectedKeys(error)).toContain('ADMIN_EMAIL');
    });

    it('accepts an ADMIN_EMAIL on a reserved TLD, which CI and the test corpus use', () => {
      const { error } = validate(
        validEnv({ ADMIN_EMAIL: 'ci-admin@example.test' }),
      );

      expect(error).toBeUndefined();
    });

    it('rejects an ADMIN_PASSWORD below the minimum length', () => {
      const { error } = validate(validEnv({ ADMIN_PASSWORD: 'short' }));

      expect(rejectedKeys(error)).toContain('ADMIN_PASSWORD');
    });
  });

  describe('TRUST_PROXY_HOPS', () => {
    it('defaults to 0 outside production', () => {
      const { error, value } = validate(validEnv());

      expect(error).toBeUndefined();
      expect(value.TRUST_PROXY_HOPS).toBe(0);
    });

    // C-D6's schema half. The container half is T6.
    //
    // No default under production, and that is the whole policy: neither
    // default is safe. 0 behind a proxy collapses every client into ONE
    // bucket (a trivial DoS against all users, and the load balancer's own
    // probes share it). Anything higher than the real hop count is a full
    // bypass. Which is worse depends on the topology, which the code cannot
    // know - so the deployer must say.
    it('is required under NODE_ENV=production, with no default', () => {
      const env = validProdEnv();
      delete env.TRUST_PROXY_HOPS;

      expect(rejectedKeys(validate(env).error)).toContain('TRUST_PROXY_HOPS');
    });

    it('accepts an explicit 0 under production, for direct-to-Node', () => {
      expect(
        validate(validProdEnv({ TRUST_PROXY_HOPS: 0 })).error,
      ).toBeUndefined();
    });

    it('accepts 2 under production, for a two-proxy chain', () => {
      expect(
        validate(validProdEnv({ TRUST_PROXY_HOPS: 2 })).error,
      ).toBeUndefined();
    });

    // Review Focus 2. Express's `trust proxy` accepts a number OR a string,
    // so an unvalidated 'abc' becomes a HOSTNAME MATCHER that trusts nothing
    // while looking configured - no error, no log, no trust. Each of these
    // must be refused at boot instead.
    it.each([
      ['a non-numeric string', 'abc'],
      ['a negative count', -1],
      ['a fractional count', 1.5],
      ['an empty string', ''],
    ])('rejects %s', (_label, bad) => {
      expect(
        rejectedKeys(validate(validEnv({ TRUST_PROXY_HOPS: bad })).error),
      ).toContain('TRUST_PROXY_HOPS');
    });
  });

  describe('payments configuration', () => {
    it('rejects a missing PAYMENT_PROVIDER — there is no default', () => {
      const env = validEnv();
      delete env.PAYMENT_PROVIDER;

      expect(validate(env).error?.message).toContain('PAYMENT_PROVIDER');
    });

    it('rejects an unknown provider name', () => {
      expect(
        validate(validEnv({ PAYMENT_PROVIDER: 'paypal' })).error?.message,
      ).toContain('PAYMENT_PROVIDER');
    });

    it('rejects the fake provider under NODE_ENV=production', () => {
      const { error } = validate(
        validEnv({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'fake' }),
      );

      expect(error?.message).toContain('PAYMENT_PROVIDER');
    });

    it('accepts the stripe provider under NODE_ENV=production when a key is set', () => {
      const { error } = validate(validProdEnv());

      expect(error).toBeUndefined();
    });

    it('requires PAYMENT_API_KEY when the provider is stripe', () => {
      const { error } = validate(validEnv({ PAYMENT_PROVIDER: 'stripe' }));

      expect(error?.message).toContain('PAYMENT_API_KEY');
    });

    it('does not require PAYMENT_API_KEY when the provider is fake', () => {
      expect(validate(validEnv()).error).toBeUndefined();
    });

    it('rejects a missing or too-short PAYMENT_WEBHOOK_SECRET', () => {
      const missing = validEnv();
      delete missing.PAYMENT_WEBHOOK_SECRET;

      expect(validate(missing).error?.message).toContain(
        'PAYMENT_WEBHOOK_SECRET',
      );
      expect(
        validate(validEnv({ PAYMENT_WEBHOOK_SECRET: 'short' })).error?.message,
      ).toContain('PAYMENT_WEBHOOK_SECRET');
    });

    it('rejects a provider timeout below the 1000ms floor', () => {
      expect(
        rejectedKeys(
          validate(validEnv({ PAYMENT_PROVIDER_TIMEOUT_MS: '100' })).error,
        ),
      ).toContain('PAYMENT_PROVIDER_TIMEOUT_MS');
    });
  });

  describe('scheduled maintenance configuration', () => {
    it('accepts an environment with no maintenance variables at all', () => {
      expect(validate(validEnv()).error).toBeUndefined();
    });

    it('rejects an order expiry TTL of 0, which would expire orders at creation', () => {
      const { error } = validate(validEnv({ ORDER_EXPIRY_TTL_MINUTES: '0' }));

      expect(error?.message).toContain('ORDER_EXPIRY_TTL_MINUTES');
    });

    it('rejects a refresh-token retention below JWT_REFRESH_TTL, which would delete live tokens', () => {
      const { error } = validate(
        validEnv({ REFRESH_TOKEN_RETENTION_DAYS: '3' }),
      );

      expect(error?.message).toContain('REFRESH_TOKEN_RETENTION_DAYS');
    });

    it('rejects a payment-event retention that would make an old replay processable again', () => {
      const { error } = validate(
        validEnv({ PAYMENT_EVENT_RETENTION_DAYS: '10' }),
      );

      expect(error?.message).toContain('PAYMENT_EVENT_RETENTION_DAYS');
    });

    it('rejects a reconcile min-age below the webhook timestamp tolerance', () => {
      // 300s tolerance == 5 minutes, so 5 is still inside the window an
      // in-flight webhook may legitimately occupy; the floor is 6.
      expect(
        rejectedKeys(
          validate(validEnv({ RECONCILE_MIN_AGE_MINUTES: '5' })).error,
        ),
      ).toContain('RECONCILE_MIN_AGE_MINUTES');
    });

    it('rejects a lease shorter than the 30-second floor', () => {
      expect(
        rejectedKeys(
          validate(validEnv({ MAINTENANCE_LEASE_SECONDS: '5' })).error,
        ),
      ).toContain('MAINTENANCE_LEASE_SECONDS');
    });

    it('rejects batch sizes above their caps, which bound one tick of work', () => {
      expect(
        rejectedKeys(
          validate(validEnv({ ORDER_EXPIRY_BATCH_SIZE: '5000' })).error,
        ),
      ).toContain('ORDER_EXPIRY_BATCH_SIZE');
      expect(
        rejectedKeys(
          validate(validEnv({ MAINTENANCE_PURGE_BATCH_SIZE: '50000' })).error,
        ),
      ).toContain('MAINTENANCE_PURGE_BATCH_SIZE');
      expect(
        rejectedKeys(
          validate(validEnv({ RECONCILE_BATCH_SIZE: '5000' })).error,
        ),
      ).toContain('RECONCILE_BATCH_SIZE');
    });

    it('defaults the jobs switch on, so omitting it does not disable maintenance', () => {
      const { value } = validate(validEnv());

      expect(value.MAINTENANCE_JOBS_ENABLED).toBe(true);
    });
  });
});
