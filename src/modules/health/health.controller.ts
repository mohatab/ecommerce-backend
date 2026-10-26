import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators/public.decorator';

interface HealthStatus {
  status: 'ok';
  timestamp: string;
}

interface LivenessStatus {
  status: 'ok';
}

@ApiTags('health')
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness: is this process up and able to answer at all.
   *
   * Deliberately does NO I/O — no database, no provider, no file system — and
   * is deliberately SYNCHRONOUS so it cannot grow an `await` by accident.
   *
   * It must never consult the database, and that is not a style preference.
   * `PrismaService.onModuleInit()` calls `$connect()`, and a failure there
   * propagates to `main.ts`'s `bootstrap().catch` -> `process.exit(1)`. So a
   * liveness probe pointed at the database-touching `/health` turns a
   * transient database blip into an UNBOOTABLE CRASH LOOP: the restart cannot
   * succeed while the database is down, where the running container would
   * have reconnected on its own through Prisma's pool. The restart actively
   * prevents the recovery that would otherwise have happened.
   *
   * There is no 503 branch, because there is nothing to check. If the process
   * cannot answer, the absence of a response IS the signal.
   *
   * @SkipThrottle is also load-bearing, and the asymmetry with `check()` is
   * deliberate: `/health` costs a database round trip and stays throttled, or
   * an unauthenticated caller gets a database-load amplifier. This one costs
   * nothing, so skipping is free. Do not "simplify" by skipping both.
   */
  @Get('live')
  @SkipThrottle()
  @ApiOperation({ summary: 'Liveness probe — process only, no dependencies' })
  @ApiResponse({ status: 200, description: 'The process is serving' })
  live(): LivenessStatus {
    return { status: 'ok' };
  }

  @Get()
  @ApiOperation({ summary: 'Check application and database health' })
  @ApiResponse({
    status: 200,
    description: 'Application and database are healthy',
  })
  @ApiResponse({ status: 503, description: 'Database is unreachable' })
  async check(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error(
        'Health check failed: database unreachable',
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException('Database is unreachable');
    }

    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
