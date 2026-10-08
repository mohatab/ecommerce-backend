import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Category,
  OrderStatus,
  Prisma,
  Product,
  Role,
  User,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { TokenService } from '../src/modules/auth/token.service';
import { MaintenanceJobName } from '../src/modules/maintenance/maintenance-job-name.enum';
import { MaintenanceLeaseService } from '../src/modules/maintenance/maintenance-lease.service';
import { MaintenancePurgeService } from '../src/modules/maintenance/maintenance-purge.service';
import { MaintenanceRunnerService } from '../src/modules/maintenance/maintenance-runner.service';
import { OrderExpiryService } from '../src/modules/maintenance/order-expiry.service';
import { PaymentReconciliationService } from '../src/modules/maintenance/payment-reconciliation.service';
import { ReconciliationFindingWriter } from '../src/modules/maintenance/reconciliation-finding.writer';
import { OrdersService } from '../src/modules/orders/orders.service';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import {
  PAYMENT_PROVIDER,
  SUPPORTED_EVENT_TYPE,
} from '../src/modules/payments/provider/payment-provider';
import { ProductsService } from '../src/modules/products/products.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createCategory } from './factories/category.factory';
import { createOrder, OrderWithItems } from './factories/order.factory';
import { createProduct } from './factories/product.factory';
import { createUser } from './factories/user.factory';
import { assertStockConserved } from './helpers/assert-stock-conserved';
import { createTestApp } from './helpers/create-test-app';
import { resetLeases } from './helpers/reset-leases';
import { truncateAll } from './helpers/truncate';

/**
 * Spec §14.3 and §9.3.6. Every Phase 5 concurrency claim, under real parallel
 * HTTP against real PostgreSQL, each paired with a recorded negative control
 * that fails against the naive implementation it protects. The controls are
 * applied by hand, observed, and reverted; the captured output lives in
 * `.superpowers/sdd/2026-10-07-phase-5-scheduled-maintenance/task-7-report.md`.
 * No naive code is committed and no test-only switch exists in `src/`.
 *
 * Harness rules, inherited from Phase 3 and Phase 4 and each established by a
 * real failure:
 *  - `await app.listen(0)`: supertest against an unlistened server calls
 *    listen(0) per request, which throws ERR_SERVER_ALREADY_LISTEN under
 *    `Promise.all`;
 *  - `createTestApp([], { throttleLimit: 0 })`: a boolean trigger, not a cap.
 *    The admin trigger route is 5/min and this suite fires twenty at once;
 *  - tokens minted through `TokenService`, never `/auth/login`, so the 5/min
 *    auth throttle is never in the loop;
 *  - `resetLeases()` beside `truncateAll()`: truncation deliberately leaves
 *    `maintenance_leases` alone, so a lease a previous test left held would
 *    make every job here report 'lease-held';
 *  - `runner.run(...)` is called directly, never a cron: nothing advances a
 *    timer anywhere in this file;
 *  - every test asserts that no response is a 5xx — a 500 would otherwise
 *    masquerade as a correct refusal.
 */
describe('Maintenance concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let provider: FakePaymentProvider;
  let runner: MaintenanceRunnerService;
  let products: ProductsService;
  let user: User;
  let token: string;
  let adminToken: string;
  let category: Category;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    runner = app.get(MaintenanceRunnerService);
    products = app.get(ProductsService);

    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await resetLeases(prisma);
    provider.reset();

    user = await createUser(prisma);
    token = await tokens.signAccessToken(user);
    const admin = await createUser(prisma, { role: Role.ADMIN });

    adminToken = await tokens.signAccessToken(admin);
    category = await createCategory(prisma);
  });

  /**
   * An order shaped the way checkout leaves one: the product's stock is
   * already decremented by the ordered quantity, so `assertStockConserved`
   * holds against `initialStock` both before and after the sweep.
   */
  async function pendingOrder(
    lines: { product: Product; quantity: number }[],
    expiresAt: Date,
  ): Promise<OrderWithItems> {
    for (const line of lines) {
      await prisma.product.update({
        where: { id: line.product.id },
        data: { stockQuantity: { decrement: line.quantity } },
      });
    }

    return createOrder(
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

  const past = (): Date => new Date(Date.now() - 60_000);

  const cancel = (orderId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${token}`);

  /**
   * A second maintenance instance: its own lease holder, its own
   * `OrdersService`, sharing nothing with the app's instance but the
   * database. That is what two processes look like, and it is the only way
   * the fencing identity stays consistent — `OrdersService.expire()` asserts
   * the lease through the lease service it was constructed with, so a runner
   * built on lease B must also be built on an `OrdersService` on lease B.
   */
  function newRunner(): MaintenanceRunnerService {
    const config = app.get(ConfigService);
    const lease = new MaintenanceLeaseService(prisma, config);
    const orders = new OrdersService(prisma, products, lease);
    const expiry = new OrderExpiryService(
      prisma,
      config,
      orders,
      app.get(ReconciliationFindingWriter),
      provider,
    );

    return new MaintenanceRunnerService(
      config,
      lease,
      expiry,
      app.get(MaintenancePurgeService),
      app.get(PaymentReconciliationService),
    );
  }

  it('expiry racing cancel restores stock exactly once', async () => {
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const order = await pendingOrder([{ product, quantity: 3 }], past());

    expect(await stockOf(product.id)).toBe(7);

    const [cancelled, summary] = await Promise.all([
      cancel(order.id),
      runner.run(MaintenanceJobName.ORDER_EXPIRY),
    ]);

    expect(cancelled.status).toBeLessThan(500);
    // 200 if the cancel's CAS won, 409 if expiry claimed the order first.
    expect([200, 409]).toContain(cancelled.status);
    expect(summary.failed).toBe(0);

    // Restored ONCE, by whichever path claimed the order. Both restoring is
    // the defect this test exists for: the CAS in cancel() and the CAS in
    // expire() both predicate on `status: PENDING`, so exactly one matches.
    expect(await stockOf(product.id)).toBe(10);
    expect([OrderStatus.CANCELLED, OrderStatus.EXPIRED]).toContain(
      await statusOf(order.id),
    );
    await assertStockConserved(prisma, product.id, 10);
  });

  it('restores every product exactly once with twenty-five cancels racing one sweep', async () => {
    // Twenty-five orders, each holding its own product, so a double
    // restoration shows up as that product's stock exceeding its initial
    // value and the failure names the product.
    //
    // This shape was written to make the read-check-update control (C-E1)
    // reproducible rather than lucky, and IT DID NOT: run three times against
    // the naive implementation, it stayed green, because all twenty-five
    // cancels commit before the sweep reaches the first order's read, so the
    // naive read sees CANCELLED and refuses by itself. C-E1 reproduces only
    // under a forced interleaving — a delay inside cancel()'s transaction
    // holding the order's row lock — which is strong evidence that the CAS is
    // what prevents the double restoration and weak evidence that this suite
    // would catch the regression unaided. Spec §14.4's amendment and
    // task-7-report.md record it as a qualified result; do not read this test
    // as the control.
    const lines: { product: Product; order: OrderWithItems }[] = [];

    for (let index = 0; index < 25; index += 1) {
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 10,
      });

      lines.push({
        product,
        order: await pendingOrder([{ product, quantity: 2 }], past()),
      });
    }

    const [summary, ...responses] = await Promise.all([
      runner.run(MaintenanceJobName.ORDER_EXPIRY),
      ...lines.map((line) => cancel(line.order.id)),
    ]);

    expect(responses.filter((response) => response.status >= 500)).toEqual([]);
    expect(summary.failed).toBe(0);
    expect(summary.examined).toBe(25);
    // Every order reached exactly one terminal state, and every product got
    // its two units back exactly once.
    expect(summary.affected + summary.skipped).toBe(25);

    for (const line of lines) {
      expect(await stockOf(line.product.id)).toBe(10);
      expect([OrderStatus.CANCELLED, OrderStatus.EXPIRED]).toContain(
        await statusOf(line.order.id),
      );
      await assertStockConserved(prisma, line.product.id, 10);
    }
  });

  it('expiry racing the webhook yields exactly one terminal state', async () => {
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    // Tier A — no Payment row — so the sweep vets it without a provider read
    // and the race is purely between the two writers. The webhook creates the
    // payment row itself, as it does for any order it has not seen.
    const order = await pendingOrder([{ product, quantity: 4 }], past());
    const body = JSON.stringify({
      id: `evt_${order.id}`,
      type: SUPPORTED_EVENT_TYPE,
      providerPaymentId: `pi_${order.id}`,
      orderId: order.id,
      amountMinorUnits: order.totalCents,
      // Lowercase: the adapter normalises on the way in, and a real provider
      // sends lowercase.
      currency: 'usd',
    });

    const [delivered, summary] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', provider.signWebhook(body))
        .send(body),
      runner.run(MaintenanceJobName.ORDER_EXPIRY),
    ]);

    // The event is authentic in every interleaving, so it is always 200 —
    // including the one where the sweep won and `markPaid()` reports
    // 'expired'. A 4xx there would tell the provider to stop retrying an
    // event it was right to send.
    expect(delivered.status).toBe(200);
    expect(summary.failed).toBe(0);

    const status = await statusOf(order.id);

    expect([OrderStatus.PAID, OrderStatus.EXPIRED]).toContain(status);
    // Exactly one terminal state, and the stock follows from it: a paid
    // order keeps its units, an expired one has given them back. Both are
    // conserved; only a double restoration or a lost one is not.
    expect(await stockOf(product.id)).toBe(
      status === OrderStatus.PAID ? 6 : 10,
    );
    await assertStockConserved(prisma, product.id, 10);
  });

  it('two runner instances with distinct holders restore stock exactly once', async () => {
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const order = await pendingOrder([{ product, quantity: 5 }], past());
    const a = newRunner();
    const b = newRunner();

    const [first, second] = await Promise.all([
      a.run(MaintenanceJobName.ORDER_EXPIRY),
      b.run(MaintenanceJobName.ORDER_EXPIRY),
    ]);

    const outcomes = [first, second];

    // The lease is what makes one of them not work at all. Without it both
    // would sweep, and the per-order CAS — not the lease — is what would
    // still keep the restoration single (spec §9.3.4).
    expect(
      outcomes.filter((summary) => summary.status === 'completed'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((summary) => summary.reason === 'lease-held'),
    ).toHaveLength(1);
    expect(outcomes.filter((summary) => summary.failed > 0)).toEqual([]);

    expect(await statusOf(order.id)).toBe(OrderStatus.EXPIRED);
    expect(await stockOf(product.id)).toBe(10);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('twenty concurrent admin triggers produce one run and no 5xx', async () => {
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const order = await pendingOrder([{ product, quantity: 3 }], past());

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app.getHttpServer())
          .post(
            `/api/v1/admin/maintenance/${MaintenanceJobName.ORDER_EXPIRY}/run`,
          )
          .set('Authorization', `Bearer ${adminToken}`),
      ),
    );

    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);

    expect(await statusOf(order.id)).toBe(OrderStatus.EXPIRED);
    expect(await stockOf(product.id)).toBe(10);
    await assertStockConserved(prisma, product.id, 10);
  });

  /**
   * Control C-E3 (spec §14.4), and the phase's highest-risk claim: a PARTIAL
   * restoration must be impossible. An order whose transition commits with
   * only some of its lines restored destroys inventory silently, and nothing
   * ever re-selects it, because it is no longer PENDING.
   *
   * The failure is induced MID-LOOP — after the first `incrementStock` has
   * already run inside the transaction — which is the only shape that tests
   * ROLLBACK. A control that throws before any mutation would prove the
   * fence instead, and the e2e test that rejects at `assertHeld` already
   * covers that.
   *
   * Against the shipped code the throw unwinds the single transaction, so
   * neither product moves and the order stays PENDING. Against the naive
   * implementation — the restoration loop outside the transaction, or one
   * transaction per line — the first increment commits and this test fails
   * naming the product that was restored on its own.
   */
  it('restores nothing when the restoration loop fails midway', async () => {
    const first = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const second = await createProduct(prisma, category.id, {
      stockQuantity: 20,
    });
    const order = await pendingOrder(
      [
        { product: first, quantity: 2 },
        { product: second, quantity: 5 },
      ],
      past(),
    );

    expect(await stockOf(first.id)).toBe(8);
    expect(await stockOf(second.id)).toBe(15);

    const real = products.incrementStock.bind(products);
    let calls = 0;
    const spy = jest
      .spyOn(products, 'incrementStock')
      .mockImplementation(
        async (
          tx: Prisma.TransactionClient,
          productId: string,
          quantity: number,
        ): Promise<void> => {
          calls += 1;

          if (calls === 2) {
            throw new Error('induced mid-loop restoration failure');
          }

          await real(tx, productId, quantity);
        },
      );

    try {
      const summary = await runner.run(MaintenanceJobName.ORDER_EXPIRY);

      // The sweep counts the order as failed and completes the tick; the
      // order is re-selected on the next one, against fresh state.
      expect(summary.status).toBe('completed');
      expect(summary.examined).toBe(1);
      expect(summary.affected).toBe(0);
      expect(summary.failed).toBe(1);
      // Both increments were attempted, so the failure really was mid-loop.
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }

    // All three together are the invariant. The first two are what a partial
    // restoration breaks; the third is what makes the order re-selectable.
    expect(await stockOf(first.id)).toBe(8);
    expect(await stockOf(second.id)).toBe(15);
    expect(await statusOf(order.id)).toBe(OrderStatus.PENDING);
    await assertStockConserved(prisma, first.id, 10);
    await assertStockConserved(prisma, second.id, 20);
  });
});
