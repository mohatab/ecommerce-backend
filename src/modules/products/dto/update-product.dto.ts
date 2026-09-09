import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUppercase,
  IsUrl,
  IsUUID,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Written out in full rather than via PartialType(CreateProductDto), because
 * it carries one field CreateProductDto does not: isActive, which is how a
 * deactivated product is restored.
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Desk Lamp' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'An adjustable desk lamp.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: 4999, description: 'Price in minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceCents?: number;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  @IsUppercase()
  currency?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/lamp.png' })
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  imageUrl?: string;

  @ApiPropertyOptional({ example: '0195f0a0-0000-7000-8000-000000000001' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Set true to restore a deactivated product',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
