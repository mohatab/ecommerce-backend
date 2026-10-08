import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { RECONCILIATION_FINDING_KINDS } from '../reconciliation-finding.writer';
// `import type` is required for a type used in a decorated property signature
// under isolatedModules + emitDecoratorMetadata (TS1272).
import type { ReconciliationFindingKind } from '../reconciliation-finding.writer';

/**
 * `enableImplicitConversion` is false, so a query boolean arrives as the
 * STRING 'true' or 'false'. `@Type(() => Boolean)` cannot be used: Boolean
 * ('false') is `true`, which would silently invert the filter.
 *
 * Anything that is neither spelling is left as-is so `@IsBoolean` rejects it
 * with a 400. Coercing an unrecognised value to `false` would make
 * `?resolved=yes` quietly return the opposite list.
 */
function toBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === true) {
    return true;
  }

  if (value === 'false' || value === false) {
    return false;
  }

  return value;
}

export class FindingListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RECONCILIATION_FINDING_KINDS })
  @IsOptional()
  @IsEnum(RECONCILIATION_FINDING_KINDS)
  kind?: ReconciliationFindingKind;

  /**
   * Defaults to false — ACTIVE findings only (spec §8.5, §10.4). An operator
   * opening this route wants current divergences without having to ask;
   * resolved rows are history and are retrieved with `?resolved=true`.
   */
  @ApiPropertyOptional({
    default: false,
    description: 'false (default) lists active findings; true lists resolved',
  })
  @Transform(toBoolean)
  @IsBoolean()
  resolved: boolean = false;
}
