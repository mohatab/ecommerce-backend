import { INestApplication, ModuleMetadata } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';

export interface CreateTestAppOptions {
  /**
   * Bypasses the ThrottlerGuard entirely for suites that exercise many auth
   * requests and are not testing throttling. `@Throttle()` metadata on
   * register/login/refresh always wins over an injected THROTTLER_OPTIONS
   * override (see @nestjs/throttler's canActivate resolution order), so
   * raising the numeric limit does not unblock those routes — only replacing
   * the guard's provider does. Omit this option to run the real production
   * limits — auth-throttle.e2e-spec.ts depends on that default. Any value
   * passed here (including `0`) bypasses the guard; it is a boolean trigger,
   * not a cap.
   *
   * Implementation note: this uses `overrideProvider(ThrottlerGuard)`, not
   * `overrideGuard(ThrottlerGuard)`. `overrideGuard` only replaces providers
   * Nest's DI considers "injectables"; a guard registered solely as
   * `{ provide: APP_GUARD, useClass: ThrottlerGuard }` never appears there,
   * so `overrideGuard` silently no-ops against it. `AppModule` registers
   * `ThrottlerGuard` as its own class-token provider (aliased into
   * `APP_GUARD` via `useExisting`) specifically so `overrideProvider` here
   * has a real target.
   */
  throttleLimit?: number;
}

export async function createTestApp(
  extraImports: NonNullable<ModuleMetadata['imports']> = [],
  options: CreateTestAppOptions = {},
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [AppModule, ...extraImports],
  });

  if (options.throttleLimit !== undefined) {
    builder.overrideProvider(ThrottlerGuard).useValue({
      canActivate: () => true,
    });
  }

  const moduleFixture: TestingModule = await builder.compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();

  return app;
}
