export interface AppConfig {
  app: {
    port: number;
    env: string;
  };
  database: {
    url: string;
  };
  cors: {
    origin: string;
  };
  jwt: {
    secret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  admin: {
    email: string | undefined;
    password: string | undefined;
  };
  payments: {
    provider: 'stripe' | 'fake';
    apiKey: string | undefined;
    webhookSecret: string;
    timeoutMs: number;
  };
  maintenance: {
    jobsEnabled: boolean;
    orderExpiryCron: string;
    orderExpiryTtlMinutes: number;
    orderExpiryPaymentStartedTtlHours: number;
    orderExpiryBatchSize: number;
    purgeCron: string;
    purgeBatchSize: number;
    refreshTokenRetentionDays: number;
    paymentEventRetentionDays: number;
    reconcileCron: string;
    reconcileMinAgeMinutes: number;
    reconcileLookbackDays: number;
    reconcileBatchSize: number;
    reconcilePrecheckFailureThreshold: number;
    leaseSeconds: number;
  };
}

/**
 * Reads a variable that has no safe default.
 *
 * `JWT_SECRET` used to fall back to `''`. Joi already makes that unreachable
 * on the boot path, but the fallback is precisely what would run if Joi ever
 * did not — a script importing this factory directly, or a future
 * `ignoreEnvVars`. An empty HMAC key does not fail; it signs and verifies
 * happily, and every token becomes forgeable by anyone who guesses that the
 * key is empty. Silence is the worst possible failure mode for this one
 * value, so it throws instead.
 */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. It has no default: refusing to start rather than ` +
        `fall back to an empty value.`,
    );
  }

  return value;
}

export default (): AppConfig => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    env: process.env.NODE_ENV ?? 'development',
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
  },
  jwt: {
    secret: requireEnv('JWT_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
  },
  admin: {
    // Optional by design: the API must boot without bootstrap credentials.
    // The bootstrap script requires them at runtime and aborts loudly if
    // either is missing. They are never read on any request path.
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
  payments: {
    // No default (spec §12.1), for the reason requireEnv exists: Joi guarding
    // the boot path is not the same as this factory being safe, and the paths
    // Joi does not run — a script importing it directly, a future
    // `ignoreEnvVars` — are exactly where a silent fallback would bite. The
    // fallback that was here defaulted to 'fake', the one value production
    // forbids, so an unset variable would have chosen a provider that marks
    // orders paid without taking money. It throws instead.
    //
    // Joi has already restricted this to 'stripe' | 'fake' and forbidden
    // 'fake' under NODE_ENV=production. The cast records that; it does not
    // create the guarantee.
    provider: requireEnv('PAYMENT_PROVIDER') as 'stripe' | 'fake',
    // Only the Stripe adapter needs it; Joi requires it when provider=stripe.
    apiKey: process.env.PAYMENT_API_KEY,
    // Same class of value as JWT_SECRET, so it uses the same helper for the
    // same reason: an empty HMAC key does not fail loudly, it verifies
    // happily, and anyone who guesses it can forge paid-order events.
    webhookSecret: requireEnv('PAYMENT_WEBHOOK_SECRET'),
    timeoutMs: parseInt(process.env.PAYMENT_PROVIDER_TIMEOUT_MS ?? '10000', 10),
  },
  maintenance: {
    // Opt-out, not opt-in: a deployment that forgets the variable still runs
    // its maintenance. Only the literal 'false' disables it.
    jobsEnabled: process.env.MAINTENANCE_JOBS_ENABLED !== 'false',
    orderExpiryCron: process.env.ORDER_EXPIRY_CRON ?? '0 */5 * * * *',
    orderExpiryTtlMinutes: parseInt(
      process.env.ORDER_EXPIRY_TTL_MINUTES ?? '30',
      10,
    ),
    orderExpiryPaymentStartedTtlHours: parseInt(
      process.env.ORDER_EXPIRY_PAYMENT_STARTED_TTL_HOURS ?? '24',
      10,
    ),
    orderExpiryBatchSize: parseInt(
      process.env.ORDER_EXPIRY_BATCH_SIZE ?? '100',
      10,
    ),
    purgeCron: process.env.MAINTENANCE_PURGE_CRON ?? '0 0 3 * * *',
    purgeBatchSize: parseInt(
      process.env.MAINTENANCE_PURGE_BATCH_SIZE ?? '1000',
      10,
    ),
    refreshTokenRetentionDays: parseInt(
      process.env.REFRESH_TOKEN_RETENTION_DAYS ?? '30',
      10,
    ),
    paymentEventRetentionDays: parseInt(
      process.env.PAYMENT_EVENT_RETENTION_DAYS ?? '90',
      10,
    ),
    reconcileCron: process.env.RECONCILE_CRON ?? '0 */15 * * * *',
    reconcileMinAgeMinutes: parseInt(
      process.env.RECONCILE_MIN_AGE_MINUTES ?? '15',
      10,
    ),
    reconcileLookbackDays: parseInt(
      process.env.RECONCILE_LOOKBACK_DAYS ?? '30',
      10,
    ),
    reconcileBatchSize: parseInt(process.env.RECONCILE_BATCH_SIZE ?? '100', 10),
    reconcilePrecheckFailureThreshold: parseInt(
      process.env.RECONCILE_PRECHECK_FAILURE_THRESHOLD ?? '3',
      10,
    ),
    leaseSeconds: parseInt(process.env.MAINTENANCE_LEASE_SECONDS ?? '300', 10),
  },
});
