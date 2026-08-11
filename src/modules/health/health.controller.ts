import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';

interface HealthStatus {
  status: 'ok';
  timestamp: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

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
