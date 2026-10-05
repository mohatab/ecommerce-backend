import {
  INestApplication,
  NestApplicationOptions,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  app.use(helmet());
  app.enableCors({ origin: configService.get('cors.origin', { infer: true }) });

  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
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
