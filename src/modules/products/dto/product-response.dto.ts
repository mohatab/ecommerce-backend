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

  // D10 (spec §4.1.1): the exact stock level is PUBLIC by decision, not by
  // accident of DTO reuse. Removing it from the public catalog is a product
  // decision, not a cleanup.
  @ApiProperty({ example: 42, description: 'Units available for sale' })
  stockQuantity!: number;

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
    dto.stockQuantity = product.stockQuantity;
    dto.imageUrl = product.imageUrl;
    dto.isActive = product.isActive;
    dto.categoryId = product.categoryId;
    dto.category = CategoryResponseDto.from(product.category);
    dto.createdAt = product.createdAt;

    return dto;
  }
}
