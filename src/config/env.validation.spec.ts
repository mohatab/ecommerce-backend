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
    ...overrides,
  };
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

    it('reports every problem at once rather than stopping at the first', () => {
      // abortEarly: false is what makes a misconfigured deploy fixable in one
      // pass instead of one variable per restart.
      const { error } = validate({ NODE_ENV: 'staging', PORT: '70000' });

      expect(rejectedKeys(error)).toEqual(
        expect.arrayContaining(['NODE_ENV', 'PORT', 'DATABASE_URL']),
      );
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
});
