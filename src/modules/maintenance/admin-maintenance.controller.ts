import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';
import { FindingListQueryDto } from './dto/finding-list-query.dto';
import { JobSummaryResponseDto } from './dto/job-summary-response.dto';
import { ReconciliationFindingResponseDto } from './dto/reconciliation-finding-response.dto';
import { RunJobParamsDto } from './dto/run-job-params.dto';
import { MaintenanceRunnerService } from './maintenance-runner.service';
import { ReconciliationFindingWriter } from './reconciliation-finding.writer';

/**
 * Both routes are ADMIN-only through ONE class-level decorator — the Phase 2
 * structural pattern, for the same reason: the likeliest authorization defect
 * is a route that forgets `@Roles()`, and a class-level decorator turns
 * several chances to forget into one.
 */
@ApiTags('admin-maintenance')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminMaintenanceController {
  constructor(
    private readonly runner: MaintenanceRunnerService,
    private readonly findings: ReconciliationFindingWriter,
  ) {}

  /**
   * Synchronous on purpose (spec §10.2): Phase 5 has no queue, every job is
   * bounded by its batch size, and the lease already provides the property a
   * `202` would be used for — refusing a concurrent run — with an immediate,
   * honest 409.
   *
   * It reaches the job through exactly the same `MaintenanceRunnerService.run`
   * the cron does, so the trigger cannot drift from the schedule, and takes
   * the same lease, which is what stops an admin launching twenty concurrent
   * sweeps and exhausting the connection pool.
   */
  @Post('maintenance/:job/run')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Run a maintenance job synchronously' })
  @ApiResponse({
    status: 200,
    description: 'Completed, or skipped because the job found nothing to do',
    type: JobSummaryResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Unknown job name' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an administrator',
  })
  @ApiResponse({ status: 409, description: 'The job is already running' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async run(@Param() params: RunJobParamsDto): Promise<JobSummaryResponseDto> {
    const summary = await this.runner.run(params.job);

    if (summary.status === 'skipped' && summary.reason === 'lease-held') {
      // 409, not a 200 with a reason: the caller asked for the job to run and
      // it did not. A 200 here would make a lost trigger look like a quiet
      // success, which is exactly the signal an operator needs.
      throw new ConflictException('Maintenance job is already running');
    }

    return JobSummaryResponseDto.from(summary);
  }

  @Get('reconciliation/findings')
  @ApiOperation({
    summary: 'List reconciliation findings',
    description:
      'Defaults to active findings (resolvedAt IS NULL). Pass ' +
      'resolved=true for the historical ones.',
  })
  @ApiPaginatedResponse(ReconciliationFindingResponseDto)
  @ApiResponse({
    status: 400,
    description: 'Invalid pagination, kind, or resolved value',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an administrator',
  })
  async list(
    @Query() query: FindingListQueryDto,
  ): Promise<PaginatedDto<ReconciliationFindingResponseDto>> {
    const { items, total } = await this.findings.list({
      kind: query.kind,
      resolved: query.resolved,
      skip: query.skip,
      take: query.limit,
    });

    return PaginatedDto.from(
      items.map((item) => ReconciliationFindingResponseDto.from(item)),
      total,
      query,
    );
  }
}
