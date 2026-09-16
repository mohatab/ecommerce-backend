import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductsService } from '../products/products.service';

type UpsertArgs = [Record<string, unknown>];
type CountArgs = [{ where: Record<string, unknown> }];

describe('CartService', () => {
  let service: CartService;
  let prisma: {
    cart: {
      upsert: jest.Mock<Promise<{ id: string }>, UpsertArgs>;
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    };
    cartItem: {
      upsert: jest.Mock<Promise<unknown>, UpsertArgs>;
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
      findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
      count: jest.Mock<Promise<number>, CountArgs>;
      deleteMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
    $transaction: jest.Mock<
      Promise<unknown>,
      [(tx: unknown) => Promise<unknown>]
    >;
  };
  let products: { findOne: jest.Mock<Promise<unknown>, [string, string]> };

  beforeEach(() => {
    prisma = {
      cart: {
        upsert: jest
          .fn<Promise<{ id: string }>, UpsertArgs>()
          .mockResolvedValue({ id: 'cart-1' }),
        findUnique: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue(null),
      },
      cartItem: {
        upsert: jest.fn<Promise<unknown>, UpsertArgs>().mockResolvedValue({}),
        findUnique: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue(null),
        findMany: jest
          .fn<Promise<unknown[]>, [unknown]>()
          .mockResolvedValue([]),
        count: jest.fn<Promise<number>, CountArgs>().mockResolvedValue(0),
        deleteMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
      $transaction: jest
        .fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>()
        .mockImplementation((callback) => callback(prisma)),
    };
    products = {
      findOne: jest.fn<Promise<unknown>, [string, string]>().mockResolvedValue({
        id: 'product-1',
      }),
    };

    service = new CartService(
      prisma as unknown as PrismaService,
      products as unknown as ProductsService,
    );
  });

  it('takes the cart row lock before touching any item', async () => {
    const order: string[] = [];
    prisma.cart.upsert.mockImplementation(() => {
      order.push('lock');
      return Promise.resolve({ id: 'cart-1' });
    });
    prisma.cartItem.upsert.mockImplementation(() => {
      order.push('item');
      return Promise.resolve({});
    });
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

    await service.setItem('user-1', 'product-1', 2);

    expect(order).toEqual(['lock', 'item']);
  });

  it('writes an absolute quantity and never an increment (D11)', async () => {
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

    await service.setItem('user-1', 'product-1', 2);

    const args = prisma.cartItem.upsert.mock.calls[0][0] as {
      update: { quantity: number };
      create: { quantity: number };
    };
    expect(args.update).toEqual({ quantity: 2 });
    expect(args.create).toMatchObject({ quantity: 2 });
  });

  it('validates the product as active before writing', async () => {
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

    await service.setItem('user-1', 'product-1', 1);

    expect(products.findOne.mock.calls[0]).toEqual([
      'product-1',
      'active-only',
    ]);
  });

  it('rejects a 51st distinct line with 422', async () => {
    prisma.cartItem.findUnique.mockResolvedValue(null);
    prisma.cartItem.count.mockResolvedValue(50);

    await expect(
      service.setItem('user-1', 'product-51', 1),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.cartItem.upsert).not.toHaveBeenCalled();
  });

  it('allows updating an existing line when the cart is already at the cap', async () => {
    prisma.cartItem.findUnique.mockResolvedValue({ id: 'item-1' });
    prisma.cartItem.count.mockResolvedValue(50);
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

    await expect(
      service.setItem('user-1', 'product-1', 3),
    ).resolves.toBeDefined();
  });

  it('returns checkout items sorted by productId', async () => {
    await service.listItemsForCheckout(
      prisma as unknown as Prisma.TransactionClient,
      'cart-1',
    );

    expect(prisma.cartItem.findMany.mock.calls[0][0]).toEqual({
      where: { cartId: 'cart-1' },
      orderBy: { productId: 'asc' },
    });
  });
});
