import * as Joi from 'joi';

/**
 * The `30s` / `15m` / `24h` / `7d` forms, and nothing else.
 *
 * Without this, `JWT_REFRESH_TTL="fifteen"` passes validation, the app boots
 * clean, and the first register or login throws out of `parseDurationMs` as a
 * 500 — a config typo surfacing as a runtime fault, which is exactly what
 * this project's fail-fast rule exists to prevent.
 *
 * Deliberately the same pattern `TokenService.parseDurationMs` accepts, and
 * deliberately applied to the access TTL too. `JWT_ACCESS_TTL` is handed to
 * jsonwebtoken, whose `ms` parser accepts far more (`"2 days"`, `"10h"`), so
 * validating both against the stricter of the two keeps one format across
 * both variables rather than two subtly different ones.
 */
const TTL_PATTERN = /^\d+[smhd]$/;

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string().uri().required(),
  CORS_ORIGIN: Joi.string().default('*'),
  TEST_DATABASE_URL: Joi.string().uri().optional(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().pattern(TTL_PATTERN).default('15m'),
  JWT_REFRESH_TTL: Joi.string().pattern(TTL_PATTERN).default('7d'),
  // tlds: { allow: false } deliberately. Joi's default email rule validates
  // the TLD against the IANA list, which rejects reserved TLDs like .test
  // and private ones like .internal. That is stricter than RegisterDto's
  // class-validator @IsEmail(), so the default would let registration accept
  // an address the bootstrap could not create — and it would fail CI, which
  // bootstraps ci-admin@example.test.
  ADMIN_EMAIL: Joi.string()
    .email({ tlds: { allow: false } })
    .optional(),
  ADMIN_PASSWORD: Joi.string().min(8).max(128).optional(),
  // Required with no default: a fake provider silently marking orders paid in
  // production is the worst realistic misconfiguration in this phase, so the
  // choice is always explicit. Under NODE_ENV=production only 'stripe' is
  // accepted, and boot ABORTS otherwise — enforced here, not by convention.
  PAYMENT_PROVIDER: Joi.string()
    .valid('stripe', 'fake')
    .required()
    .when('NODE_ENV', {
      is: 'production',
      // Joi.override is load-bearing: a `then` branch is CONCATENATED onto the
      // base schema, so a bare `Joi.valid('stripe')` would ADD 'stripe' to the
      // already-allowed set and leave 'fake' just as valid under production.
      // Verified empirically — without the override, NODE_ENV=production with
      // PAYMENT_PROVIDER=fake validates clean, which is precisely the boot this
      // rule exists to abort.
      then: Joi.valid(Joi.override, 'stripe'),
    }),
  PAYMENT_API_KEY: Joi.string().when('PAYMENT_PROVIDER', {
    is: 'stripe',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  PAYMENT_WEBHOOK_SECRET: Joi.string().min(16).required(),
  PAYMENT_PROVIDER_TIMEOUT_MS: Joi.number().integer().min(1000).default(10000),

  // Phase 5 — scheduled maintenance. The three floors below are the point of
  // this block: each one blocks a misconfiguration that destroys data or
  // fabricates findings silently, rather than failing loudly at runtime.
  MAINTENANCE_JOBS_ENABLED: Joi.boolean().default(true),
  ORDER_EXPIRY_CRON: Joi.string().default('0 */5 * * * *'),
  // Floor of 1: a TTL of 0 would stamp expiresAt = now() on every checkout and
  // expire orders the instant they are created.
  ORDER_EXPIRY_TTL_MINUTES: Joi.number().integer().min(1).default(30),
  ORDER_EXPIRY_PAYMENT_STARTED_TTL_HOURS: Joi.number()
    .integer()
    .min(1)
    .default(24),
  ORDER_EXPIRY_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(100),
  MAINTENANCE_PURGE_CRON: Joi.string().default('0 0 3 * * *'),
  MAINTENANCE_PURGE_BATCH_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .default(1000),
  // Floor of 7 == JWT_REFRESH_TTL. Below it the purge would delete LIVE tokens.
  REFRESH_TOKEN_RETENTION_DAYS: Joi.number().integer().min(7).default(30),
  // Floor of 30: payment_events is the webhook idempotency ledger; deleting a
  // row makes a pre-cutoff replay newly processable.
  PAYMENT_EVENT_RETENTION_DAYS: Joi.number().integer().min(30).default(90),
  RECONCILE_CRON: Joi.string().default('0 */15 * * * *'),
  // Floor of 6 minutes: must exceed WEBHOOK_TOLERANCE_SECONDS (300s), or an
  // in-flight payment is reported as divergent.
  RECONCILE_MIN_AGE_MINUTES: Joi.number().integer().min(6).default(15),
  RECONCILE_LOOKBACK_DAYS: Joi.number().integer().min(1).default(30),
  RECONCILE_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(100),
  RECONCILE_PRECHECK_FAILURE_THRESHOLD: Joi.number()
    .integer()
    .min(1)
    .default(3),
  MAINTENANCE_LEASE_SECONDS: Joi.number().integer().min(30).default(300),
});
