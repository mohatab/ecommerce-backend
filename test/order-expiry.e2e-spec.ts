import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Category, OrderStatus, Product, User } from '@prisma/client';
import { App } from 'supertest/types';
import { MaintenanceJobName } from '../src/modules/maintenance/maintenance-job-name.enum';
import {
  LeaseLostError,
  MaintenanceLeaseService,
} from '../src/modules/maintenance/maintenance-lease.service';
import { MaintenanceRunnerService } from '../src/modules/maintenance/maintenance-runner.service';
import { OrderExpiryService } from '../src/modules/maintenance/order-expiry.service';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/provider/payment-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { createCategory } from './factories/category.factory';
import { createOrder } from './factories/order.factory';
import { createPayment } from './factories/payment.factory';
import { createProduct } from './factories/product.factory';
import { createUser } from './factories/user.factory';
import { assertStockConserved } from './helpers/assert-stock-conserved';
import { createTestApp } from './helpers/create-test-app';
import { resetLeases } from './helpers/reset-leases';
import { truncateAll } from './helpers/truncate';

const HOUR_MS = 3_600_000;

/**
 * The expiry sweep against real PostgreSQL. Time is deterministic without any
 * clock abstraction, because both deadlines are STORED data: an already-due
 * order is one written with a past `expiresAt`, and a tier-B order past its
 * gate is one whose `Payment.createdAt` is backdated (spec §14.6).
 */
describe('Order expiry sweep (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let runner: MaintenanceRunnerService;
  let provider: FakePaymentProvider;
  let user: User;
  let category: Category;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    runner = app.get(MaintenanceRunnerService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // truncateAll() deliberately leaves maintenance_leases alone, so a lease a
    // previous test left held would make every job here report 'lease-held'.
    await resetLeases(prisma);
    provider.reset();

    user = await createUser(prisma);
    category = await createCategory(prisma);
  });

  /**
   * An order shaped the way checkout leaves one: the product's stock is
   * already decremented by the ordered quantity, so conservation holds against
   * `initialStock` both before and after the sweep.
   */
  async function pendingOrder(
    lines: { product: Product; quantity: number }[],
    expiresAt: Date | null,
  ): Promise<string> {
    for (const line of lines) {
      await prisma.product.update({
        where: { id: line.product.id },
        data: { stockQuantity: { decrement: line.quantity } },
      });
    }

    const order = await createOrder(
      prisma,
      user.id,
      lines.map((line) => ({
        productId: line.product.id,
        productName: line.product.name,
        unitPriceCents: line.product.priceCents,
        quantity: line.quantity,
      })),
      { expiresAt },
    );

    return order.id;
  }

  function stockOf(productId: string): Promise<number> {
    return prisma.product
      .findUniqueOrThrow({
        where: { id: productId },
        select: { stockQuantity: true },
      })
      .then((row) => row.stockQuantity);
  }

  function statusOf(orderId: string): Promise<OrderStatus> {
    return prisma.order
      .findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })
      .then((row) => row.status);
  }

  it('expires a tier-A order past its deadline and restores exactly its units', async () => {
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const orderId = await pendingOrder(
      [{ product, quantity: 3 }],
      new Date(Date.now() - 60_000),
    );

    expect(await stockOf(product.id)).toBe(7);

    const summary = await runner.run(MaintenanceJobName.ORDER_EXPIRY);

    expect(summary).toMatchObject({
      job: MaintenanceJobName.ORDER_EXPIRY,
      status: 'completed',
      examined: 1,
      affected: 1,
      skipped: 0,
      failed: 0,
    });

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    expect(after.status).toBe(OrderStatus.EXPIRED);
    expect(after.expiredAt).not.toBeNull();
    // The deadline itself is never rewritten: expiresAt records the deadline,
    // expiredAt records the action.
    expect(after.expiresAt).not.toBeNull();
    expect(await stockOf(product.id)).toBe(10);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('expires an order whose deadline is exactly the query instant', async () => {
    // An order due at this instant, not before it. The `<=` versus `<` fork
    // itself is pinned by the unit assertion on the selection predicate
    // (order-expiry.service.spec.ts), because the sweep's own `now()` is
    // strictly later than any timestamp a test can write and so cannot be
    // made equal to it without a clock seam the spec rules out (§14.6).
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });
    await pendingOrder([{ product, quantity: 1 }], new Date());

    expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).affected).toBe(
      1,
    );
    expect(await stockOf(product.id)).toBe(5);
  });

  it('restores every line of a multi-item order together', async () => {
    const first = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const second = await createProduct(prisma, category.id, {
      stockQuantity: 20,
    });
    const orderId = await pendingOrder(
      [
        { product: first, quantity: 2 },
        { product: second, quantity: 5 },
      ],
      new Date(Date.now() - 60_000),
    );

    expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).affected).toBe(
      1,
    );

    expect(await statusOf(orderId)).toBe(OrderStatus.EXPIRED);
    expect(await stockOf(first.id)).toBe(10);
    expect(await stockOf(second.id)).toBe(20);
    await assertStockConserved(prisma, first.id, 10);
    await assertStockConserved(prisma, second.id, 20);
  });

  it('never selects a PAID order, however old its deadline', async () => {
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const orderId = await pendingOrder(
      [{ product, quantity: 4 }],
      new Date(Date.now() - HOUR_MS),
    );
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PAID },
    });

    expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).examined).toBe(
      0,
    );
    expect(await statusOf(orderId)).toBe(OrderStatus.PAID);
    // A paid order's stock is never restored.
    expect(await stockOf(product.id)).toBe(6);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('never selects an order with no deadline', async () => {
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const orderId = await pendingOrder([{ product, quantity: 2 }], null);

    expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).examined).toBe(
      0,
    );
    expect(await statusOf(orderId)).toBe(OrderStatus.PENDING);
    expect(await stockOf(product.id)).toBe(8);
  });

  describe('tier B — a payment was initiated', () => {
    let product: Product;
    let orderId: string;

    beforeEach(async () => {
      product = await createProduct(prisma, category.id, {
        stockQuantity: 10,
      });
      orderId = await pendingOrder(
        [{ product, quantity: 3 }],
        new Date(Date.now() - HOUR_MS),
      );
    });

    /**
     * Mints a real intent in the provider, then points a local Payment row at
     * it. `paymentAgeHours` backdates the row, which is what moves the order
     * past tier B's 24-hour gate.
     */
    async function withPayment(paymentAgeHours: number): Promise<string> {
      const intent = await provider.createPayment({
        orderId,
        amountMinorUnits: 1000,
        currency: 'USD',
        idempotencyKey: `expiry-${orderId}`,
      });

      await createPayment(prisma, orderId, {
        providerPaymentId: intent.providerPaymentId,
        createdAt: new Date(Date.now() - paymentAgeHours * HOUR_MS),
      });

      return intent.providerPaymentId;
    }

    async function expectUntouched(): Promise<void> {
      expect(await statusOf(orderId)).toBe(OrderStatus.PENDING);
      expect(await stockOf(product.id)).toBe(7);
      await assertStockConserved(prisma, product.id, 10);
    }

    it('does not expire an order still inside its 24-hour payment gate', async () => {
      await withPayment(1);

      expect(await runner.run(MaintenanceJobName.ORDER_EXPIRY)).toMatchObject({
        examined: 1,
        affected: 0,
        skipped: 1,
        failed: 0,
      });
      await expectUntouched();
    });

    it('expires an order past its payment gate the provider still calls pending', async () => {
      await withPayment(48);

      expect((await runner.run(MaintenanceJobName.ORDER_EXPIRY)).affected).toBe(
        1,
      );
      expect(await statusOf(orderId)).toBe(OrderStatus.EXPIRED);
      expect(await stockOf(product.id)).toBe(10);
    });

    it('does not expire an order the provider reports succeeded', async () => {
      // D3: the read is a veto, never an authority — the order stays PENDING
      // and is NOT marked PAID. Only the verified webhook writes PAID.
      const providerPaymentId = await withPayment(48);
      provider.markNextRetrieveSucceeded(providerPaymentId);

      expect(await runner.run(MaintenanceJobName.ORDER_EXPIRY)).toMatchObject({
        affected: 0,
        skipped: 1,
        failed: 0,
      });
      await expectUntouched();
    });

    it('does not expire an order when the provider read fails', async () => {
      // Unavailable, timeout, 5xx — all indistinguishable, all fail closed.
      await withPayment(48);
      provider.failNextRetrieve();

      expect(await runner.run(MaintenanceJobName.ORDER_EXPIRY)).toMatchObject({
        affected: 0,
        failed: 1,
      });
      await expectUntouched();
    });

    it('does not expire an order whose intent the provider does not recognise', async () => {
      await withPayment(48);
      provider.notFoundNextRetrieve();

      expect(await runner.run(MaintenanceJobName.ORDER_EXPIRY)).toMatchObject({
        affected: 0,
        skipped: 1,
        failed: 0,
      });
      await expectUntouched();
    });
  });

  it('commits nothing when this instance does not hold the lease', async () => {
    // Spec §9.3.6 test 3 at sweep level. The lease is taken by a DIFFERENT
    // instance, so the fencing assertHeld() inside expire()'s transaction
    // fails and the whole transaction rolls back — the transition and the
    // restoration go together or not at all (§4.5).
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const orderId = await pendingOrder(
      [{ product, quantity: 3 }],
      new Date(Date.now() - 60_000),
    );

    const other = new MaintenanceLeaseService(prisma, app.get(ConfigService));
    await expect(other.acquire(MaintenanceJobName.ORDER_EXPIRY)).resolves.toBe(
      'acquired',
    );

    await expect(app.get(OrderExpiryService).sweep()).rejects.toBeInstanceOf(
      LeaseLostError,
    );

    expect(await statusOf(orderId)).toBe(OrderStatus.PENDING);
    expect(await stockOf(product.id)).toBe(7);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('reports a skipped tick when another instance holds the lease', async () => {
    const other = new MaintenanceLeaseService(prisma, app.get(ConfigService));
    await other.acquire(MaintenanceJobName.ORDER_EXPIRY);

    expect(await runner.run(MaintenanceJobName.ORDER_EXPIRY)).toMatchObject({
      status: 'skipped',
      reason: 'lease-held',
      examined: 0,
    });
  });
});
