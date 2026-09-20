import { Order, OrderItem, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Same serial-suite caveat as the other factories. */
let sequence = 0;

export interface OrderLineInput {
  productId: string;
  productName: string;
  unitPriceCents: number;
  quantity: number;
}

export type OrderWithItems = Order & { items: OrderItem[] };

/**
 * Builds an order directly, bypassing checkout. Use it for read/cancel
 * tests; never use it to assert anything about stock, because it does NOT
 * decrement stock the way checkout does.
 */
export async function createOrder(
  prisma: PrismaService,
  userId: string,
  lines: OrderLineInput[],
  overrides: Partial<Prisma.OrderUncheckedCreateInput> = {},
): Promise<OrderWithItems> {
  sequence += 1;

  const totalCents = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );

  return prisma.order.create({
    data: {
      userId,
      status: OrderStatus.PENDING,
      totalCents,
      currency: 'USD',
      idempotencyKey: `factory-key-${sequence}`,
      ...overrides,
      items: { create: lines },
    },
    include: { items: true },
  });
}
