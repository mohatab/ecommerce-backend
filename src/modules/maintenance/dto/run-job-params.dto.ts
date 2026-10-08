import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { MaintenanceJobName } from '../maintenance-job-name.enum';

/**
 * The `:job` path parameter as a validated allowlist.
 *
 * `@IsEnum` means an unlisted value is a 400 from the global ValidationPipe
 * and NEVER reaches dispatch — the same rule as Phase 2's sort whitelist: no
 * free-form caller string selects code. The runner's typed `Record` is the
 * second half of that guarantee; this is the first.
 */
export class RunJobParamsDto {
  @ApiProperty({
    enum: MaintenanceJobName,
    example: MaintenanceJobName.ORDER_EXPIRY,
  })
  @IsEnum(MaintenanceJobName)
  job!: MaintenanceJobName;
}
