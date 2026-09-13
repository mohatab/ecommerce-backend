import { ApiProperty } from '@nestjs/swagger';
import { CategoryResponseDto } from '../../categories/dto/category-response.dto';
import { ProductWithCategory } from '../types/product-visibility';

export class ProductResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: 'Desk Lamp' })
  name!: string;

  @ApiProperty({ example: 'An adjustable desk lamp.' })
  description!: string;

  // Integer minor units. Never a decimal example here.
  @ApiProperty({ example: 4999, description: 'Price in minor units' })
  priceCents!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ nullable: true, example: null })
  imageUrl!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000001' })
  categoryId!: string;

  @ApiProperty({ type: CategoryResponseDto })
  category!: CategoryResponseDto;

  @ApiProperty()
  createdAt!: Date;

  static from(product: ProductWithCategory): ProductResponseDto {
    const dto = new ProductResponseDto();

    dto.id = product.id;
    dto.name = product.name;
    dto.description = product.description;
    dto.priceCents = product.priceCents;
    dto.currency = product.currency;
    dto.imageUrl = product.imageUrl;
    dto.isActive = product.isActive;
    dto.categoryId = product.categoryId;
    dto.category = CategoryResponseDto.from(product.category);
    dto.createdAt = product.createdAt;

    return dto;
  }
}
