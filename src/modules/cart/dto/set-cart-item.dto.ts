import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class SetCartItemDto {
  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: 99,
    description:
      'The quantity this line should have. This SETS the quantity; it does ' +
      'not add to it. Remove a line with DELETE, not with quantity 0.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}
