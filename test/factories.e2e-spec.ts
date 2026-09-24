import { Category, OrderStatus, PaymentStatus, Product } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './helpers/truncate';
import { assertStockConserved } from './helpers/assert-stock-conserved';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { createCart, createCartItem } from './factories/cart.factory';
import { createOrder } from './factories/order.factory';
import { createPayment } from './factories/payment.factory';
import { createPaymentEvent } from './factories/payment-event.factory';

describe('catalog factories', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  it('creates a category', async () => {
    const category = await createCategory(prisma);

    const found = await prisma.category.findUnique({
      where: { id: category.id },
    });

    expect(found).not.toBeNull();
    expect(typeof category.id).toBe('string');
    expect(category.id.length).toBeGreaterThan(0);
    expect(category.name).toBeTruthy();
    expect(category.slug).toBeTruthy();
  });

  it('creates a product with a valid category', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    const found = await prisma.product.findUnique({
      where: { id: product.id },
    });

    expect(found).not.toBeNull();
    expect(product.categoryId).toBe(category.id);
    expect(Number.isInteger(product.priceCents)).toBe(true);
    expect(product.currency).toBe('USD');
    expect(product.isActive).toBe(true);
  });

  it('applies overrides on top of the defaults for both factories', async () => {
    const category = await createCategory(prisma, { name: 'Custom' });
    expect(category.name).toBe('Custom');

    const product = await createProduct(prisma, category.id, {
      isActive: false,
    });
    expect(product.isActive).toBe(false);
  });

  it('creates multiple categories and products without unique-constraint errors', async () => {
    const categories: Category[] = [];
    for (let i = 0; i < 3; i += 1) {
      categories.push(await createCategory(prisma));
    }

    const products: Product[] = [];
    for (const category of categories) {
      products.push(await createProduct(prisma, category.id));
      products.push(await createProduct(prisma, category.id));
    }

    expect(products).toHaveLength(6);

    const names = new Set(categories.map((category) => category.name));
    const slugs = new Set(categories.map((category) => category.slug));
    expect(names.size).toBe(categories.length);
    expect(slugs.size).toBe(categories.length);
  });

  describe('cart and order factories', () => {
    it('creates a cart with items and an order with snapshot lines', async () => {
      const user = await createUser(prisma);
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 7,
      });

      const cart = await createCart(prisma, user.id);
      const item = await createCartItem(prisma, cart.id, product.id, 3);

      expect(cart.id).toHaveLength(36);
      expect(item.quantity).toBe(3);
      expect(product.stockQuantity).toBe(7);

      const order = await createOrder(prisma, user.id, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 2,
        },
      ]);

      expect(order.status).toBe('PENDING');
      expect(order.totalCents).toBe(product.priceCents * 2);
      expect(order.items).toHaveLength(1);
      expect(order.items[0].productName).toBe(product.name);
    });

    it('defaults stockQuantity to 100 and honours an override', async () => {
      const category = await createCategory(prisma);
      const stocked = await createProduct(prisma, category.id);
      const empty = await createProduct(prisma, category.id, {
        stockQuantity: 0,
      });

      expect(stocked.stockQuantity).toBe(100);
      expect(empty.stockQuantity).toBe(0);
    });

    it('refuses to store negative stock (database CHECK constraint)', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 1,
      });

      await expect(
        prisma.product.update({
          where: { id: product.id },
          data: { stockQuantity: { decrement: 5 } },
        }),
      ).rejects.toThrow();
    });
  });

  describe('payment factories', () => {
    it('creates a payment for an order and a standalone payment event', async () => {
      const user = await createUser(prisma);
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const order = await createOrder(prisma, user.id, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 1,
        },
      ]);

      const payment = await createPayment(prisma, order.id);

      expect(payment.orderId).toBe(order.id);
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(payment.succeededAt).toBeNull();
      expect(payment.id).toMatch(/^[0-9a-f-]{36}$/);

      const event = await createPaymentEvent(prisma);

      expect(event.type).toBe('payment_intent.succeeded');
      expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    // Pins the Phase 4 change to assertStockConserved. A PAID order's stock
    // was taken by checkout and is never given back, so the helper must keep
    // counting it as held. If PAID drops out of that sum the assertion below
    // reads 7 + 0 === 10 and fails an invariant that is not broken.
    it('counts a PAID order as still holding its stock', async () => {
      const user = await createUser(prisma);
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 10,
      });

      await createOrder(
        prisma,
        user.id,
        [
          {
            productId: product.id,
            productName: product.name,
            unitPriceCents: product.priceCents,
            quantity: 3,
          },
        ],
        { status: OrderStatus.PAID },
      );
      // createOrder bypasses checkout, so the decrement checkout would have
      // performed is applied by hand here.
      await prisma.product.update({
        where: { id: product.id },
        data: { stockQuantity: { decrement: 3 } },
      });

      await assertStockConserved(prisma, product.id, 10);
    });
  });
});
