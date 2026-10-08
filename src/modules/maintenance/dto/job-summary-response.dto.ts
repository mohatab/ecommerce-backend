import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MaintenanceJobName } from '../maintenance-job-name.enum';
import { JobSummary } from '../maintenance-runner.service';

/**
 * COUNTS ONLY (spec §10.3). No provider payload, no `clientSecret`, no order,
 * payment, customer, or finding identifier — an operator who needs detail uses
 * `GET /admin/reconciliation/findings`, which is itself ADMIN-only and
 * DTO-mapped. `MaintenanceLease.holder` is an internal instance UUID and is
 * never on this object either (§12).
 *
 * The mapping is explicit rather than a spread of `JobSummary`, so a field
 * added to the internal summary cannot reach a client by default.
 */
export class JobSummaryResponseDto {
  @ApiProperty({
    enum: MaintenanceJobName,
    example: MaintenanceJobName.ORDER_EXPIRY,
  })
  job!: MaintenanceJobName;

  @ApiProperty({ example: '2026-10-07T12:00:00.000Z' })
  startedAt!: Date;

  @ApiProperty({ example: 412 })
  durationMs!: number;

  @ApiProperty({ enum: ['completed', 'skipped'], example: 'completed' })
  status!: 'completed' | 'skipped';

  /**
   * Present only when `status` is `skipped`. `lease-held` never appears here —
   * the controller turns that case into a 409 — so in practice this is
   * `lease-missing`.
   *
   * **`disabled` is unreachable today** and is documented anyway: the
   * scheduler registers no cron at all when `MAINTENANCE_JOBS_ENABLED=false`,
   * so nothing ever returns it. It stays in the Swagger enum because it is a
   * member of `JobSummary['reason']`, and a documented enum narrower than the
   * type it describes is the worse defect — a client written against the docs
   * would reject a value the type permits. Remove it from both, or from
   * neither.
   */
  @ApiPropertyOptional({ enum: ['lease-held', 'lease-missing', 'disabled'] })
  reason?: 'lease-held' | 'lease-missing' | 'disabled';

  @ApiProperty({ example: 37 })
  examined!: number;

  @ApiProperty({ example: 12 })
  affected!: number;

  @ApiProperty({ example: 25 })
  skipped!: number;

  @ApiProperty({ example: 0 })
  failed!: number;

  static from(summary: JobSummary): JobSummaryResponseDto {
    const dto = new JobSummaryResponseDto();

    dto.job = summary.job;
    dto.startedAt = summary.startedAt;
    dto.durationMs = summary.durationMs;
    dto.status = summary.status;
    dto.examined = summary.examined;
    dto.affected = summary.affected;
    dto.skipped = summary.skipped;
    dto.failed = summary.failed;

    // Assigned only when set: an `undefined` property is dropped by
    // JSON.stringify, so a completed run serialises to exactly the eight
    // documented keys.
    if (summary.reason !== undefined) {
      dto.reason = summary.reason;
    }

    return dto;
  }
}
