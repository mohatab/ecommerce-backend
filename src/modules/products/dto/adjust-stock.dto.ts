import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min, NotEquals } from 'class-validator';

export class AdjustStockDto {
  @ApiProperty({
    example: 25,
    description:
      'Signed change in units. Positive restocks, negative removes. ' +
      'Relative by design: an absolute set would silently erase concurrent sales.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  @NotEquals(0)
  delta!: number;
}
