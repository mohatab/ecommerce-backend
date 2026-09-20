import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductsService } from '../products/products.service';

type UpsertArgs = [Record<string, unknown>];
type CountArgs = [{ where: Record<string, unknown> }];

describe('CartService', () => {
  let service: CartService;
  // Distinct from `prisma`, and returned by the $transaction mock below, so
  // every assertion on "was this called with the transaction client" fails if
  // the service ever hoists a write out of the transaction and calls
  // this.prisma directly (same pattern as checkout.service.spec.ts and
  // orders.service.spec.ts). A shared mock where tx === prisma cannot tell
  // the two apart and passes either way.
  let txMock: {
    cart: { upsert: jest.Mock<Promise<{ id: string }>, UpsertArgs> };
    cartItem: {
      upsert: jest.Mock<Promise<unknown>, UpsertArgs>;
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
      findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
      count: jest.Mock<Promise<number>, CountArgs>;
      deleteMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
  };
  let prisma: {
    cart: {
      upsert: jest.Mock<Promise<{ id: string }>, UpsertArgs>;
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    };
    cartItem: {
      upsert: jest.Mock<Promise<unknown>, UpsertArgs>;
      deleteMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
    $transaction: jest.Mock<
      Promise<unknown>,
      [(tx: unknown) => Promise<unknown>]
    >;
  };
  let products: { findOne: jest.Mock<Promise<unknown>, [string, string]> };

  beforeEach(() => {
    txMock = {
      cart: {
        upsert: jest
          .fn<Promise<{ id: string }>, UpsertArgs>()
          .mockResolvedValue({ id: 'cart-1' }),
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
    };
    prisma = {
      // Present, and deliberately never expected to be called for any write:
      // these are the base-client doubles a hoisted mutation would land on.
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
        deleteMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
      $transaction: jest
        .fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>()
        .mockImplementation((callback) => callback(txMock)),
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

  describe('setItem', () => {
    it('takes the cart row lock before touching any item', async () => {
      const order: string[] = [];
      txMock.cart.upsert.mockImplementation(() => {
        order.push('lock');
        return Promise.resolve({ id: 'cart-1' });
      });
      txMock.cartItem.upsert.mockImplementation(() => {
        order.push('item');
        return Promise.resolve({});
      });
      prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

      await service.setItem('user-1', 'product-1', 2);

      expect(order).toEqual(['lock', 'item']);
    });

    it('takes the lock and writes the item on the transaction client, never the base client', async () => {
      prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

      await service.setItem('user-1', 'product-1', 2);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txMock.cart.upsert).toHaveBeenCalledTimes(1);
      expect(txMock.cartItem.upsert).toHaveBeenCalledTimes(1);
      // The mutation must be inside the transaction: if it is hoisted out it
      // lands on these base-client doubles instead.
      expect(prisma.cart.upsert).not.toHaveBeenCalled();
      expect(prisma.cartItem.upsert).not.toHaveBeenCalled();
    });

    it('writes an absolute quantity and never an increment (D11)', async () => {
      prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

      await service.setItem('user-1', 'product-1', 2);

      const args = txMock.cartItem.upsert.mock.calls[0][0] as {
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
      txMock.cartItem.findUnique.mockResolvedValue(null);
      txMock.cartItem.count.mockResolvedValue(50);

      await expect(
        service.setItem('user-1', 'product-51', 1),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(txMock.cartItem.upsert).not.toHaveBeenCalled();
    });

    it('allows updating an existing line when the cart is already at the cap', async () => {
      txMock.cartItem.findUnique.mockResolvedValue({ id: 'item-1' });
      txMock.cartItem.count.mockResolvedValue(50);
      prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

      await expect(
        service.setItem('user-1', 'product-1', 3),
      ).resolves.toBeDefined();
    });
  });

  describe('removeItem', () => {
    it('takes the cart lock and deletes on the transaction client, never the base client', async () => {
      prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1' });

      await service.removeItem('user-1', 'product-1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txMock.cart.upsert).toHaveBeenCalledTimes(1);
      expect(txMock.cartItem.deleteMany.mock.calls[0][0]).toEqual({
        where: { cartId: 'cart-1', productId: 'product-1' },
      });
      expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
    });

    it('locks before deleting', async () => {
      const order: string[] = [];
      prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1' });
      txMock.cart.upsert.mockImplementation(() => {
        order.push('lock');
        return Promise.resolve({ id: 'cart-1' });
      });
      txMock.cartItem.deleteMany.mockImplementation(() => {
        order.push('delete');
        return Promise.resolve({ count: 1 });
      });

      await service.removeItem('user-1', 'product-1');

      expect(order).toEqual(['lock', 'delete']);
    });

    it('is a no-op for a user with no cart, and creates no carts row', async () => {
      prisma.cart.findUnique.mockResolvedValue(null);

      await expect(
        service.removeItem('user-1', 'product-1'),
      ).resolves.toBeUndefined();

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(txMock.cart.upsert).not.toHaveBeenCalled();
      expect(txMock.cartItem.deleteMany).not.toHaveBeenCalled();
    });
  });

  it('returns checkout items sorted by productId', async () => {
    await service.listItemsForCheckout(
      txMock as unknown as Prisma.TransactionClient,
      'cart-1',
    );

    expect(txMock.cartItem.findMany.mock.calls[0][0]).toEqual({
      where: { cartId: 'cart-1' },
      orderBy: { productId: 'asc' },
    });
  });
});
