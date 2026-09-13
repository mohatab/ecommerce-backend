import { ApiProperty } from '@nestjs/swagger';
import { Category } from '@prisma/client';

export class CategoryResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: 'Desks' })
  name!: string;

  @ApiProperty({ example: 'desks' })
  slug!: string;

  @ApiProperty()
  createdAt!: Date;

  // Explicit field-by-field mapping, never a spread. @Exclude() silently does
  // nothing on Prisma's plain objects, so this is the only mechanism that
  // actually prevents field leaks.
  static from(category: Category): CategoryResponseDto {
    const dto = new CategoryResponseDto();

    dto.id = category.id;
    dto.name = category.name;
    dto.slug = category.slug;
    dto.createdAt = category.createdAt;

    return dto;
  }
}
