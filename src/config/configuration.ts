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
});
