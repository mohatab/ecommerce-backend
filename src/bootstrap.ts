import {
  INestApplication,
  NestApplicationOptions,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Application } from 'express';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AppConfig } from './config/configuration';

/**
 * Construction options, as distinct from configuration.
 *
 * `rawBody` is a NestFactory *create* option, not something `configureApp()`
 * can set — but it is consumed by two different factories (`main.ts` uses
 * `NestFactory.create`, the e2e harness uses
 * `TestingModule#createNestApplication`). Writing `{ rawBody: true }` at both
 * call sites by hand is exactly the runtime/e2e divergence `configureApp()`
 * exists to prevent: one side silently loses webhook signature verification
 * while the other stays green.
 *
 * So: one definition, two consumers. `configureApp()` below remains the single
 * CONFIGURATION seam; this constant is the single CONSTRUCTION seam. They live
 * in the same file so the pairing cannot be missed.
 *
 * Why raw bytes at all: the payment webhook's signature is an HMAC over the
 * exact bytes the provider sent. `JSON.parse` then `JSON.stringify` does not
 * reproduce them (key order, whitespace, unicode escaping), so verification
 * against a re-serialised body fails for every authentic event. Route-local
 * `express.raw()` middleware is deliberately NOT used (spec §5.2).
 */
export const NEST_APP_OPTIONS: NestApplicationOptions = { rawBody: true };

export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService<AppConfig, true>);

  // Trusted proxy, and therefore every throttle bucket: ThrottlerGuard's
  // getTracker() returns bare `req.ip`, and Express's `req.ip` honours this.
  // No custom tracker, no guard subclass.
  //
  // A NUMBER, never `true`. `true` makes Express take the LEFTMOST
  // X-Forwarded-For entry, which is entirely attacker-supplied - the 5/min
  // limit on login would become unlimited, since rotating the header mints a
  // fresh bucket per request. A numeric N counts from the RIGHT, skipping
  // exactly as many entries as there are proxies that will append.
  //
  // It lives here, in configureApp(), and not in main.ts, because this is the
  // configuration seam the e2e harness also calls. Setting it in main.ts would
  // make the production path and the tested path diverge, and the C-D1/C-D2
  // controls in test/trust-proxy.e2e-spec.ts would be asserting against a
  // different app than the one that ships.
  //
  // getHttpAdapter().getInstance() keeps this function's INestApplication
  // signature; `set` is an Express method.
  // The cast narrows the adapter's untyped (`any`) instance; the Express
  // platform is fixed by NestFactory.create in main.ts and the e2e harness.
  (app.getHttpAdapter().getInstance() as Application).set(
    'trust proxy',
    configService.get('app.trustProxyHops', { infer: true }),
  );

  app.use(helmet());
  app.enableCors({ origin: configService.get('cors.origin', { infer: true }) });

  app.setGlobalPrefix('api', {
    // Two entries, not one. A route is matched by its FULL path, so `health`
    // does not cover `health/live`: without the second entry the liveness
    // probe is served at /api/health/live while /health stays unprefixed —
    // and every liveness test that only checks for a 200 still passes.
    // Infrastructure probes need stable, unprefixed, unversioned paths.
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/live', method: RequestMethod.GET },
    ],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableShutdownHooks();
}
