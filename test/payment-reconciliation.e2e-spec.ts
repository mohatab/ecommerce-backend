import { INestApplication } from '@nestjs/common';
import {
  Category,
  OrderStatus,
  PaymentStatus,
  Product,
  ReconciliationFinding,
  User,
} from '@prisma/client';
import { App } from 'supertest/types';
import { MaintenanceJobName } from '../src/modules/maintenance/maintenance-job-name.enum';
import { MaintenanceRunnerService } from '../src/modules/maintenance/maintenance-runner.service';
import {
  ReconciliationFindingKind,
  ReconciliationFindingWriter,
} from '../src/modules/maintenance/reconciliation-finding.writer';
import { FakePaymentProvider } from '../src/modules/payments/provider/fake-payment.provider';
import { PAYMENT_PROVIDER } from '../src/modules/payments/provider/payment-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { createCategory } from './factories/category.factory';
import { createOrder } from './factories/order.factory';
import { createPayment } from './factories/payment.factory';
import { createProduct } from './factories/product.factory';
import { createUser } from './factories/user.factory';
import { createTestApp } from './helpers/create-test-app';
import { resetLeases } from './helpers/reset-leases';
import { truncateAll } from './helpers/truncate';

const MINUTE_MS = 60_000;

/**
 * Reconciliation against real PostgreSQL.
 *
 * Time is deterministic without a clock abstraction (spec §14.6): a payment
 * old enough to be a candidate is simply one written with a backdated
 * `createdAt`, which is the same column the selection predicate reads.
 *
 * The lifecycle assertions are here rather than in a unit spec on purpose.
 * "One row, however many passes observe it" is a claim about a UNIQUE INDEX,
 * and a mocked Prisma client has no index to violate — see the mutation note
 * on the duplicate test below.
 */
describe('Payment reconciliation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let runner: MaintenanceRunnerService;
  let writer: ReconciliationFindingWriter;
  let provider: FakePaymentProvider;
  let user: User;
  let category: Category;
  let product: Product;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    runner = app.get(MaintenanceRunnerService);
    writer = app.get(ReconciliationFindingWriter);
    provider = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // truncateAll() deliberately leaves maintenance_leases alone.
    await resetLeases(prisma);
    provider.reset();

    user = await createUser(prisma);
    category = await createCategory(prisma);
    product = await createProduct(prisma, category.id);
  });

  const reconcile = () => runner.run(MaintenanceJobName.PAYMENT_RECONCILIATION);

  async function order(
    overrides: { status?: OrderStatus; totalCents?: number } = {},
  ) {
    const created = await createOrder(
      prisma,
      user.id,
      [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: 4999,
          quantity: 2,
        },
      ],
      overrides.status === undefined ? {} : { status: overrides.status },
    );

    if (overrides.totalCents !== undefined) {
      return prisma.order.update({
        where: { id: created.id },
        data: { totalCents: overrides.totalCents },
        include: { items: true },
      });
    }

    return created;
  }

  /**
   * A payment old enough for candidate set 1, pointing at an intent the fake
   * provider really minted — so `retrievePayment` answers about it instead of
   * reporting an id it never saw.
   */
  async function agedPayment(
    orderId: string,
    options: {
      amountMinorUnits?: number;
      currency?: string;
      status?: PaymentStatus;
      known?: boolean;
    } = {},
  ): Promise<{ id: string; providerPaymentId: string }> {
    let providerPaymentId = `unknown_pi_${orderId}`;

    if (options.known !== false) {
      const intent = await provider.createPayment({
        orderId,
        amountMinorUnits: options.amountMinorUnits ?? 9998,
        currency: options.currency ?? 'USD',
        idempotencyKey: `recon-${orderId}`,
      });

      providerPaymentId = intent.providerPaymentId;
    }

    const payment = await createPayment(prisma, orderId, {
      providerPaymentId,
      status: options.status ?? PaymentStatus.PENDING,
      // 60 minutes back: past RECONCILE_MIN_AGE_MINUTES (15) and well inside
      // RECONCILE_LOOKBACK_DAYS (30).
      createdAt: new Date(Date.now() - 60 * MINUTE_MS),
    });

    return { id: payment.id, providerPaymentId };
  }

  const findings = (): Promise<ReconciliationFinding[]> =>
    prisma.reconciliationFinding.findMany({ orderBy: { kind: 'asc' } });

  const only = async (): Promise<ReconciliationFinding> => {
    const rows = await findings();

    expect(rows).toHaveLength(1);

    return rows[0];
  };

  describe('finding lifecycle — three transitions and no others (spec §8.5)', () => {
    let orderId: string;
    let paymentId: string;
    const kind: ReconciliationFindingKind = 'AMOUNT_MISMATCH';
    const detail = { providerPaymentId: 'pi_x', orderTotalCents: 9998 };

    beforeEach(async () => {
      const created = await order();

      orderId = created.id;
      paymentId = (await agedPayment(orderId)).id;
    });

    it('creates a finding on first observation', async () => {
      await writer.record(orderId, paymentId, kind, detail);

      const row = await only();

      expect(row.occurrences).toBe(1);
      expect(row.resolvedAt).toBeNull();
      expect(row.firstSeenAt).toEqual(row.lastSeenAt);
    });

    /**
     * THE DUPLICATE GUARD, asserted as the guard's own promise: a second pass
     * observing the same divergence must not REJECT.
     *
     * This is phrased around the rejection on purpose. The obvious version —
     * record twice, then assert one row — does fail when `upsert` is swapped
     * for `create`, but it fails with a raw P2002 escaping `record()` before
     * any assertion runs, which is evidence about the unique index rather
     * than about the guard. Here the rejection IS the assertion's subject, so
     * the mutation is reported as "received promise rejected instead of
     * resolved" at this line. The recorded mutation run is in the task report.
     */
    it('does not reject when a second pass observes the same divergence', async () => {
      await writer.record(orderId, paymentId, kind, detail);

      await expect(
        writer.record(orderId, paymentId, kind, detail),
      ).resolves.toBeUndefined();
      await expect(findings()).resolves.toHaveLength(1);
    });

    it('does not reject when two concurrent passes observe the same divergence', async () => {
      // Two ticks overlapping — a cron and an admin trigger, or two instances
      // — reach `record()` with no transaction and no lock between them. The
      // negative control for this is the same `create` mutation: it raises
      // P2002 on whichever write loses.
      await expect(
        Promise.all([
          writer.record(orderId, paymentId, kind, detail),
          writer.record(orderId, paymentId, kind, detail),
        ]),
      ).resolves.toEqual([undefined, undefined]);
      await expect(findings()).resolves.toHaveLength(1);
    });

    it('increments occurrences and advances lastSeenAt on re-observation', async () => {
      await writer.record(orderId, paymentId, kind, detail);
      const first = await only();

      await writer.record(orderId, paymentId, kind, {
        ...detail,
        orderTotalCents: 1,
      });

      const rows = await findings();

      expect(rows).toHaveLength(1);
      expect(rows[0].occurrences).toBe(2);
      expect(rows[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(
        first.lastSeenAt.getTime(),
      );
      expect(rows[0].detail).toEqual({ ...detail, orderTotalCents: 1 });
    });

    it('resolves a finding whose condition cleared, leaving the counters alone', async () => {
      await writer.record(orderId, paymentId, kind, detail);
      await writer.resolve(orderId, kind);

      const row = await only();

      expect(row.resolvedAt).not.toBeNull();
      expect(row.occurrences).toBe(1);
    });

    it('re-opens the SAME row on recurrence, preserving occurrences and firstSeenAt', async () => {
      await writer.record(orderId, paymentId, kind, detail);
      const first = await only();

      await writer.resolve(orderId, kind);
      await writer.record(orderId, paymentId, kind, detail);

      const again = await only();

      expect(again.id).toBe(first.id);
      expect(again.resolvedAt).toBeNull();
      // Continues, never resets: "eleven times since <date>", not "once since
      // the last clear".
      expect(again.occurrences).toBe(2);
      expect(again.firstSeenAt).toEqual(first.firstSeenAt);
    });

    it('never deletes: resolving twice leaves the row in place', async () => {
      await writer.record(orderId, paymentId, kind, detail);
      await writer.resolve(orderId, kind);

      await expect(writer.resolve(orderId, kind)).resolves.toBe(false);
      await expect(findings()).resolves.toHaveLength(1);
    });
  });

  describe('the six kinds, through the runner (spec §8.3)', () => {
    it('records PROVIDER_SUCCESS_LOCAL_NOT_PAID without marking the order PAID', async () => {
      const created = await order();
      const { providerPaymentId } = await agedPayment(created.id);

      provider.markNextRetrieveSucceeded(providerPaymentId);

      const summary = await reconcile();
      const row = await only();

      expect(row.kind).toBe('PROVIDER_SUCCESS_LOCAL_NOT_PAID');
      expect(summary.affected).toBe(1);
      // D3/D5: the webhook is still the only writer of PAID.
      await expect(
        prisma.order.findUniqueOrThrow({ where: { id: created.id } }),
      ).resolves.toMatchObject({ status: OrderStatus.PENDING });
      await expect(
        prisma.payment.findUniqueOrThrow({ where: { orderId: created.id } }),
      ).resolves.toMatchObject({ status: PaymentStatus.PENDING });
    });

    it('records AMOUNT_MISMATCH and CURRENCY_MISMATCH from a single read', async () => {
      const created = await order();

      await agedPayment(created.id, {
        amountMinorUnits: 1,
        currency: 'EUR',
      });

      await reconcile();

      expect((await findings()).map((row) => row.kind)).toEqual([
        'AMOUNT_MISMATCH',
        'CURRENCY_MISMATCH',
      ]);
    });

    it('records PROVIDER_PAYMENT_NOT_FOUND for an id the provider never minted', async () => {
      const created = await order();

      await agedPayment(created.id, { known: false });

      const summary = await reconcile();

      expect((await only()).kind).toBe('PROVIDER_PAYMENT_NOT_FOUND');
      expect(summary.failed).toBe(0);
    });

    it('records PAID_ORDER_TERMINAL_UNPAYABLE for a succeeded payment on an EXPIRED order', async () => {
      const created = await order({ status: OrderStatus.EXPIRED });

      await agedPayment(created.id, { status: PaymentStatus.SUCCEEDED });

      await reconcile();

      expect((await only()).kind).toBe('PAID_ORDER_TERMINAL_UNPAYABLE');
    });

    it('records PROVIDER_UNREACHABLE only after the threshold of consecutive failures', async () => {
      const created = await order();

      await agedPayment(created.id);

      provider.failNextRetrieve();
      const first = await reconcile();

      expect(await findings()).toHaveLength(0);
      expect(first.failed).toBe(1);

      provider.failNextRetrieve();
      await reconcile();

      expect(await findings()).toHaveLength(0);

      provider.failNextRetrieve();
      await reconcile();

      const row = await only();

      expect(row.kind).toBe('PROVIDER_UNREACHABLE');
      expect(row.detail).toMatchObject({ consecutiveFailures: 3 });
    });
  });

  describe('resolution — candidate set 3 is what makes it possible', () => {
    it('resolves a finding on a payment that has since succeeded locally', async () => {
      const created = await order();
      const payment = await agedPayment(created.id);

      provider.markNextRetrieveSucceeded(payment.providerPaymentId);
      await reconcile();

      expect((await only()).resolvedAt).toBeNull();

      // The webhook's work, simulated by its outcome: the payment is now
      // SUCCEEDED and the order PAID, so the divergence has cleared and the
      // payment leaves candidate set 1 entirely.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.SUCCEEDED, succeededAt: new Date() },
      });
      await prisma.order.update({
        where: { id: created.id },
        data: { status: OrderStatus.PAID },
      });

      const summary = await reconcile();
      const row = await only();

      // Without candidate set 3 this row would stay open forever: nothing
      // else selects it any more.
      expect(row.resolvedAt).not.toBeNull();
      expect(row.occurrences).toBe(1);
      expect(summary.affected).toBe(1);
    });

    it('leaves an open finding alone while the provider is unreachable', async () => {
      const created = await order();

      await agedPayment(created.id, { amountMinorUnits: 1 });
      await reconcile();

      expect((await only()).resolvedAt).toBeNull();

      provider.failNextRetrieve();
      await reconcile();

      // Fail closed: an outage is not evidence that the amounts now agree.
      expect((await only()).resolvedAt).toBeNull();
    });
  });

  describe('read-only with respect to business state (D5)', () => {
    it('changes no order, payment, or product row across a full pass', async () => {
      const succeeded = await order();
      const mismatched = await order();
      const cancelled = await order({ status: OrderStatus.CANCELLED });

      const known = await agedPayment(succeeded.id);

      await agedPayment(mismatched.id, { amountMinorUnits: 1 });
      await agedPayment(cancelled.id, { status: PaymentStatus.SUCCEEDED });
      provider.markNextRetrieveSucceeded(known.providerPaymentId);

      const snapshot = async () => ({
        orders: await prisma.order.findMany({ orderBy: { id: 'asc' } }),
        payments: await prisma.payment.findMany({ orderBy: { id: 'asc' } }),
        products: await prisma.product.findMany({ orderBy: { id: 'asc' } }),
      });

      const before = await snapshot();
      const summary = await reconcile();
      const after = await snapshot();

      expect(after).toEqual(before);
      expect(summary.examined).toBe(3);
      expect(await findings()).not.toHaveLength(0);
    });

    it('skips a payment younger than RECONCILE_MIN_AGE_MINUTES', async () => {
      const created = await order();

      // Not backdated: an in-flight payment is not a divergence.
      await createPayment(prisma, created.id, {
        providerPaymentId: 'pi_young',
      });

      const summary = await reconcile();

      expect(summary.examined).toBe(0);
      expect(await findings()).toHaveLength(0);
    });
  });
});
