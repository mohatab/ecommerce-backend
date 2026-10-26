import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class CreateCategoryDto {
  // @Matches(/\S/) is load-bearing and must not be "simplified" to
  // @IsNotEmpty() or @MinLength(1): both ACCEPT a whitespace-only string like
  // '   ', which the spec forbids for this field. This is deliberately
  // stricter than CreateProductDto.name, which uses @MinLength(1) and so
  // accepts '   '; aligning products is a behaviour change to a shipped route
  // and is out of scope here (spec section 4).
  @ApiProperty({ example: 'Desks', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: 'name must not be blank' })
  name!: string;

  // The pattern also enforces non-blank — it requires at least one
  // [a-z0-9] segment — so no separate emptiness check is needed. It rejects a
  // leading hyphen, a trailing hyphen, a doubled hyphen, uppercase, spaces and
  // the empty string. Client-supplied, never derived from `name`: that is the
  // existing CreateCategoryInput contract.
  @ApiProperty({
    example: 'desks',
    maxLength: 100,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  })
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must be lowercase alphanumeric segments separated by single hyphens',
  })
  slug!: string;
}
