import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * The sort whitelist. An enum plus @IsEnum means an unlisted value is
 * rejected by the global ValidationPipe with a 400 and NEVER reaches Prisma.
 * A free-form sort string handed to an ORM is an injection-shaped surface and
 * an unbounded index problem.
 */
export enum ProductSortField {
  CreatedAt = 'createdAt',
  PriceCents = 'priceCents',
  Name = 'name',
}

export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}

export class ProductListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter to one category' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Inclusive lower bound, minor units',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceCents?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Inclusive upper bound, minor units',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceCents?: number;

  @ApiPropertyOptional({
    enum: ProductSortField,
    default: ProductSortField.CreatedAt,
  })
  @IsEnum(ProductSortField)
  sort: ProductSortField = ProductSortField.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsEnum(SortOrder)
  order: SortOrder = SortOrder.Desc;
}
