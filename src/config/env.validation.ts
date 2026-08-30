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
});
