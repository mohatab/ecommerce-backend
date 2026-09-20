import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus, Prisma } from '@prisma/client';

export type OrderWithItems = Prisma.OrderGetPayload<{
  include: { items: true };
}>;

export class OrderItemResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000001' })
  productId!: string;

  @ApiProperty({
    example: 'Desk Lamp',
    description: 'The name as it was at checkout, never refreshed',
  })
  productName!: string;

  @ApiProperty({ example: 4999, description: 'Snapshot price, minor units' })
  unitPriceCents!: number;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ example: 9998, description: 'Minor units' })
  lineTotalCents!: number;
}

export class OrderResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ enum: OrderStatus, example: OrderStatus.PENDING })
  status!: OrderStatus;

  @ApiProperty({ example: 9998, description: 'Minor units' })
  totalCents!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ type: [OrderItemResponseDto] })
  items!: OrderItemResponseDto[];

  @ApiProperty({ nullable: true, example: null })
  cancelledAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  static from(order: OrderWithItems): OrderResponseDto {
    const dto = new OrderResponseDto();

    dto.id = order.id;
    dto.status = order.status;
    dto.totalCents = order.totalCents;
    dto.currency = order.currency;
    dto.cancelledAt = order.cancelledAt;
    dto.createdAt = order.createdAt;
    dto.items = order.items.map((item) => {
      const line = new OrderItemResponseDto();

      line.id = item.id;
      line.productId = item.productId;
      line.productName = item.productName;
      line.unitPriceCents = item.unitPriceCents;
      line.quantity = item.quantity;
      line.lineTotalCents = item.unitPriceCents * item.quantity;

      return line;
    });

    return dto;
  }
}
