import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';

export class CreateCategoryDto {
  // Trimmed at the DTO boundary, so every rule below and the row that gets
  // persisted all see the normalised value: @MaxLength(200) applies to the
  // trimmed length, '   ' trims to '' and so fails @Matches(/\S/), and
  // ' Desks ' collides with an existing 'Desks' on the UNIQUE index rather
  // than becoming a second row that renders identically.
  //
  // The guard on `typeof` is not defensive noise: a bare value.trim() throws
  // on a number or an object, which the global pipe would surface as a 500
  // instead of the 400 @IsString is there to produce. Passing non-strings
  // through untouched keeps validation, not the transform, in charge of them.
  //
  // @Matches(/\S/) is what rejects the trimmed-to-EMPTY result: '   ', a
  // non-breaking space and '\n' all trim to '' and fail here. Be precise about
  // why it is here, because the original reason stopped being true when the
  // trim was added: String.prototype.trim strips the whole ECMAScript
  // WhiteSpace set, so after it "non-empty" and "matches /\S/" are equivalent
  // for every string, and @IsNotEmpty() would now behave identically. It stays
  // because it is the shipped constraint and its message is asserted — not
  // because it catches anything @IsNotEmpty() would miss.
  //
  // `slug` is deliberately NOT trimmed: its pattern already forbids
  // whitespace anywhere, so a padded slug must be a 400 rather than silently
  // becoming a different valid slug.
  @ApiProperty({
    example: 'Desks',
    maxLength: 200,
    description:
      'Surrounding whitespace is trimmed before validation, so the stored and returned value may differ from what was sent.',
  })
  // `value` is typed `any` by class-transformer's TransformFnParams, so it is
  // annotated `unknown` here: that keeps @typescript-eslint/no-unsafe-return
  // satisfied by narrowing rather than by disabling the rule.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
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
