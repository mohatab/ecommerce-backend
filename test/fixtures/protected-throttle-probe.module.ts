import { Controller, Get, Module } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

// Test-only fixture: deliberately NOT @Public(), so the global JwtAuthGuard
// rejects unauthenticated requests, and deliberately given a tight @Throttle
// limit so an e2e test can trip it in a handful of requests instead of the
// production /health-style 100/60s default. This exists solely to make the
// global-guard-registration-order observable quickly; it is never wired into
// AppModule and has no production route.
@Controller('protected-throttle-probe')
export class ProtectedThrottleProbeController {
  @Get()
  @Throttle({ default: { ttl: 60_000, limit: 2 } })
  probe(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProtectedThrottleProbeController] })
export class ProtectedThrottleProbeModule {}
