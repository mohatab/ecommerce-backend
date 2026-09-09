import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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

export class CreateProductDto {
  @ApiProperty({ example: 'Desk Lamp' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'An adjustable desk lamp.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  // Integer minor units. enableImplicitConversion is false, so @Type is
  // required for the value to arrive as a number at all.
  @ApiProperty({ example: 4999, description: 'Price in minor units' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceCents!: number;

  @ApiPropertyOptional({ example: 'USD', default: 'USD' })
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

  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000001' })
  @IsUUID()
  categoryId!: string;
}
