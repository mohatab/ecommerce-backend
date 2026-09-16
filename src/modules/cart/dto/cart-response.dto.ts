import { ApiProperty } from '@nestjs/swagger';
import { ProductResponseDto } from '../../products/dto/product-response.dto';
import { CartWithItems } from '../cart.service';

export class CartItemResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ type: ProductResponseDto })
  product!: ProductResponseDto;

  @ApiProperty({
    example: 9998,
    description:
      'Live price x quantity, in minor units. Indicative only: the binding ' +
      'price is snapshotted at checkout.',
  })
  lineTotalCents!: number;
}

export class CartResponseDto {
  @ApiProperty({ type: [CartItemResponseDto] })
  items!: CartItemResponseDto[];

  @ApiProperty({ example: 9998, description: 'Indicative total, minor units' })
  totalCents!: number;

  static from(cart: CartWithItems | null): CartResponseDto {
    const dto = new CartResponseDto();

    dto.items = (cart?.items ?? []).map((item) => {
      const line = new CartItemResponseDto();

      line.id = item.id;
      line.quantity = item.quantity;
      line.product = ProductResponseDto.from(item.product);
      line.lineTotalCents = item.product.priceCents * item.quantity;

      return line;
    });

    dto.totalCents = dto.items.reduce(
      (sum, item) => sum + item.lineTotalCents,
      0,
    );

    return dto;
  }
}
