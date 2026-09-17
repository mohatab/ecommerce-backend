import {
  ConflictException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CheckoutService } from './checkout.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { ProductsService } from '../products/products.service';

type DecrementArgs = [unknown, string, number];

type TransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel;
  maxWait: number;
  timeout: number;
};

describe('CheckoutService', () => {
  let service: CheckoutService;
  // Distinct from `prisma`, and returned by the $transaction mock below, so
  // every assertion on "was this called with the transaction client" fails
  // if the service ever slips and calls this.prisma directly instead of tx.
  let txMock: {
    order: {
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
      create: jest.Mock<Promise<unknown>, [unknown]>;
    };
  };
  let prisma: {
    $transaction: jest.Mock<
      Promise<unknown>,
      [(tx: unknown) => Promise<unknown>, TransactionOptions?]
    >;
  };
  let cart: {
    lockForUpdate: jest.Mock<Promise<{ id: string }>, [unknown, string]>;
    listItemsForCheckout: jest.Mock<Promise<unknown[]>, [unknown, string]>;
    clear: jest.Mock<Promise<void>, [unknown, string]>;
  };
  let products: {
    decrementStock: jest.Mock<Promise<number>, DecrementArgs>;
    describeRefusal: jest.Mock<Promise<string>, [unknown, string]>;
    findManyForSnapshot: jest.Mock<Promise<unknown[]>, [unknown, string[]]>;
  };

  const line = (productId: string, quantity = 1) => ({
    id: `item-${productId}`,
    productId,
    quantity,
  });

  const snapshot = (id: string, priceCents = 1000, currency = 'USD') => ({
    id,
    name: `Product ${id}`,
    priceCents,
    currency,
  });

  beforeEach(() => {
    txMock = {
      order: {
        findUnique: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue(null),
        create: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ id: 'order-1', items: [] }),
      },
    };
    prisma = {
      $transaction: jest
        .fn<
          Promise<unknown>,
          [(tx: unknown) => Promise<unknown>, TransactionOptions?]
        >()
        .mockImplementation((callback) => callback(txMock)),
    };
    cart = {
      lockForUpdate: jest
        .fn<Promise<{ id: string }>, [unknown, string]>()
        .mockResolvedValue({ id: 'cart-1' }),
      listItemsForCheckout: jest
        .fn<Promise<unknown[]>, [unknown, string]>()
        .mockResolvedValue([line('b'), line('a')]),
      clear: jest
        .fn<Promise<void>, [unknown, string]>()
        .mockResolvedValue(undefined),
    };
    products = {
      decrementStock: jest
        .fn<Promise<number>, DecrementArgs>()
        .mockResolvedValue(1),
      describeRefusal: jest
        .fn<Promise<string>, [unknown, string]>()
        .mockResolvedValue('insufficient-stock'),
      findManyForSnapshot: jest
        .fn<Promise<unknown[]>, [unknown, string[]]>()
        .mockResolvedValue([snapshot('a'), snapshot('b')]),
    };

    service = new CheckoutService(
      prisma as unknown as PrismaService,
      cart as unknown as CartService,
      products as unknown as ProductsService,
    );
  });

  it('locks the cart, then replays a known key without decrementing anything', async () => {
    txMock.order.findUnique.mockResolvedValue({ id: 'existing', items: [] });

    const result = await service.checkout('user-1', 'key-abcdefgh');

    expect(result.replayed).toBe(true);
    expect(cart.lockForUpdate).toHaveBeenCalledTimes(1);
    expect(products.decrementStock).not.toHaveBeenCalled();
    expect(txMock.order.create).not.toHaveBeenCalled();
  });

  it('409s on an empty cart', async () => {
    cart.listItemsForCheckout.mockResolvedValue([]);

    await expect(
      service.checkout('user-1', 'key-abcdefgh'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('decrements in ascending productId order whatever order the cart returns', async () => {
    cart.listItemsForCheckout.mockResolvedValue([
      line('c'),
      line('a'),
      line('b'),
    ]);
    products.findManyForSnapshot.mockResolvedValue([
      snapshot('a'),
      snapshot('b'),
      snapshot('c'),
    ]);

    await service.checkout('user-1', 'key-abcdefgh');

    expect(products.decrementStock.mock.calls.map((call) => call[1])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('maps a refused decrement to its 409 message', async () => {
    products.decrementStock.mockResolvedValue(0);
    products.describeRefusal.mockResolvedValue('insufficient-stock');

    await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
      'Insufficient stock',
    );
    expect(products.describeRefusal).toHaveBeenCalledWith(txMock, 'a');

    products.describeRefusal.mockResolvedValue('inactive');
    await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
      'Product is no longer available',
    );

    products.describeRefusal.mockResolvedValue('missing');
    await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
      'Product is no longer available',
    );
  });

  it('logs a warning only when the refusal is a missing product', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    products.decrementStock.mockResolvedValue(0);

    try {
      products.describeRefusal.mockResolvedValue('insufficient-stock');
      await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
        'Insufficient stock',
      );
      expect(warnSpy).not.toHaveBeenCalled();

      products.describeRefusal.mockResolvedValue('inactive');
      await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
        'Product is no longer available',
      );
      expect(warnSpy).not.toHaveBeenCalled();

      products.describeRefusal.mockResolvedValue('missing');
      await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
        'Product is no longer available',
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reads the price snapshot only after every decrement has succeeded', async () => {
    const calls: string[] = [];
    products.decrementStock.mockImplementation(() => {
      calls.push('decrement');
      return Promise.resolve(1);
    });
    products.findManyForSnapshot.mockImplementation(() => {
      calls.push('snapshot');
      return Promise.resolve([snapshot('a'), snapshot('b')]);
    });

    await service.checkout('user-1', 'key-abcdefgh');

    expect(calls).toEqual(['decrement', 'decrement', 'snapshot']);
  });

  it('422s on a mixed-currency cart', async () => {
    products.findManyForSnapshot.mockResolvedValue([
      snapshot('a', 1000, 'USD'),
      snapshot('b', 1000, 'EUR'),
    ]);

    await expect(
      service.checkout('user-1', 'key-abcdefgh'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('422s when the total exceeds the INT column range', async () => {
    cart.listItemsForCheckout.mockResolvedValue([line('a', 99)]);
    products.findManyForSnapshot.mockResolvedValue([
      snapshot('a', 2_000_000_000),
    ]);

    await expect(
      service.checkout('user-1', 'key-abcdefgh'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('clears the cart after creating the order', async () => {
    await service.checkout('user-1', 'key-abcdefgh');

    expect(txMock.order.create).toHaveBeenCalledTimes(1);
    expect(cart.clear).toHaveBeenCalledWith(txMock, 'cart-1');
  });

  it('pins the transaction isolation level and timeouts', async () => {
    await service.checkout('user-1', 'key-abcdefgh');

    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it('runs every transactional step on the transaction client, never the base client', async () => {
    await service.checkout('user-1', 'key-abcdefgh');

    expect(txMock.order.findUnique).toHaveBeenCalledTimes(1);
    expect(cart.lockForUpdate).toHaveBeenCalledWith(txMock, 'user-1');
    expect(cart.listItemsForCheckout).toHaveBeenCalledWith(txMock, 'cart-1');
    expect(products.decrementStock).toHaveBeenCalledWith(txMock, 'a', 1);
    expect(products.decrementStock).toHaveBeenCalledWith(txMock, 'b', 1);
    expect(products.findManyForSnapshot).toHaveBeenCalledWith(txMock, [
      'a',
      'b',
    ]);
    expect(txMock.order.create).toHaveBeenCalledTimes(1);
    expect(cart.clear).toHaveBeenCalledWith(txMock, 'cart-1');
  });
});
