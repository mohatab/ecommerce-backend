import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),
    // ONE throttler, not two. ThrottlerGuard evaluates every configured
    // throttler on every request, so registering a second "auth" entry at
    // limit 5 would cap /health, /auth/me and /api/v1/ping at 5 req/min too
    // and break routing.e2e-spec.ts. Stricter auth limits come from a
    // per-route @Throttle() override of this same throttler instead.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    HealthModule,
    AuthModule,
  ],
  providers: [
    // ThrottlerGuard is registered under its own token first, then aliased
    // via useExisting — mirroring how JwtAuthGuard is wired through
    // AuthModule. This is required, not stylistic: APP_GUARD providers live
    // in the module's internal provider list, not its injectables list, so
    // TestingModuleBuilder#overrideGuard (which only replaces injectables)
    // silently no-ops against a bare `{ provide: APP_GUARD, useClass: ... }`
    // registration. Giving ThrottlerGuard its own class token makes it a
    // real injectable that overrideProvider(ThrottlerGuard) can target.
    //
    // Order matters: global guards run in registration order, so an
    // unauthenticated flood is rejected before any token or database work.
    ThrottlerGuard,
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
  ],
})
export class AppModule {}
