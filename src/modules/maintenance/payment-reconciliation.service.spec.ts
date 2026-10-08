import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderStatus,
  PaymentStatus,
  ReconciliationFinding,
} from '@prisma/client';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PaymentProvider,
  ProviderPayment,
  ProviderPaymentNotFoundError,
} from '../payments/provider/payment-provider';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import {
  ReconciliationFindingKind,
  ReconciliationFindingWriter,
} from './reconciliation-finding.writer';

interface PaymentRow {
  id: string;
  providerPaymentId: string;
  status: PaymentStatus;
  orderId: string;
  order: { status: OrderStatus; totalCents: number; currency: string };
}
interface FindManyArgs {
  where: {
    status?: PaymentStatus;
    orderId?: { in: string[] };
    order?: unknown;
    createdAt?: unknown;
  };
}

type FindMany = jest.Mock<Promise<PaymentRow[]>, [FindManyArgs]>;
type Mutation = jest.Mock<Promise<unknown>, unknown[]>;
type Retrieve = jest.Mock<Promise<ProviderPayment>, [string]>;
type Record_ = jest.Mock<
  Promise<void>,
  [string, string | null, ReconciliationFindingKind, unknown]
>;
type Resolve = jest.Mock<Promise<boolean>, [string, ReconciliationFindingKind]>;
type Open = jest.Mock<Promise<ReconciliationFinding[]>, [number]>;

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: 'pay1',
    providerPaymentId: 'pi_1',
    status: PaymentStatus.PENDING,
    orderId: 'ord1',
    order: {
      status: OrderStatus.PENDING,
      totalCents: 9998,
      currency: 'USD',
    },
    ...overrides,
  };
}

function providerPayment(
  overrides: Partial<ProviderPayment> = {},
): ProviderPayment {
  return {
    providerPaymentId: 'pi_1',
    clientSecret: 'pi_1_secret',
    amountMinorUnits: 9998,
    currency: 'USD',
    status: 'pending',
    ...overrides,
  };
}

/** An open finding row, with only the fields the service reads. */
function openFinding(
  orderId: string,
  kind: ReconciliationFindingKind,
): ReconciliationFinding {
  return { orderId, kind } as ReconciliationFinding;
}

describe('PaymentReconciliationService', () => {
  let service: PaymentReconciliationService;
  let findMany: FindMany;
  let paymentUpdate: Mutation;
  let orderUpdate: Mutation;
  let retrievePayment: Retrieve;
  let record: Record_;
  let resolve: Resolve;
  let open: Open;

  /** Set 1 and set 3 both return `rows`; set 2 is empty unless overridden. */
  function given(options: {
    unresolved?: PaymentRow[];
    refundOwed?: PaymentRow[];
    forOpen?: PaymentRow[];
  }): void {
    findMany.mockImplementation((args: FindManyArgs) => {
      if (args.where.orderId !== undefined) {
        return Promise.resolve(options.forOpen ?? []);
      }

      if (args.where.status === PaymentStatus.SUCCEEDED) {
        return Promise.resolve(options.refundOwed ?? []);
      }

      return Promise.resolve(options.unresolved ?? []);
    });
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    findMany = jest.fn<Promise<PaymentRow[]>, [FindManyArgs]>();
    paymentUpdate = jest.fn<Promise<unknown>, unknown[]>();
    orderUpdate = jest.fn<Promise<unknown>, unknown[]>();
    given({});

    const prisma = {
      payment: {
        findMany,
        update: paymentUpdate,
        updateMany: paymentUpdate,
      },
      order: { update: orderUpdate, updateMany: orderUpdate },
    } as unknown as PrismaService;

    const values: Record<string, number> = {
      'maintenance.reconcileBatchSize': 100,
      'maintenance.reconcileMinAgeMinutes': 15,
      'maintenance.reconcileLookbackDays': 30,
      'maintenance.reconcilePrecheckFailureThreshold': 3,
    };
    const config = {
      get: (key: string): number => values[key],
    } as unknown as ConfigService<AppConfig, true>;

    record = jest.fn<
      Promise<void>,
      [string, string | null, ReconciliationFindingKind, unknown]
    >();
    resolve = jest
      .fn<Promise<boolean>, [string, ReconciliationFindingKind]>()
      .mockResolvedValue(true);
    open = jest
      .fn<Promise<ReconciliationFinding[]>, [number]>()
      .mockResolvedValue([]);

    retrievePayment = jest
      .fn<Promise<ProviderPayment>, [string]>()
      .mockResolvedValue(providerPayment());

    service = new PaymentReconciliationService(
      prisma,
      config,
      { record, resolve, open } as unknown as ReconciliationFindingWriter,
      { retrievePayment } as unknown as PaymentProvider,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const kinds = (): ReconciliationFindingKind[] =>
    record.mock.calls.map(([, , kind]) => kind);

  describe('the six kinds, all from retrievePayment alone (spec §8.3)', () => {
    it('records PROVIDER_SUCCESS_LOCAL_NOT_PAID and does NOT mark anything paid', async () => {
      given({ unresolved: [payment()] });
      retrievePayment.mockResolvedValue(
        providerPayment({ status: 'succeeded' }),
      );

      await service.run();

      expect(kinds()).toContain('PROVIDER_SUCCESS_LOCAL_NOT_PAID');
      // D5: detection only. The webhook stays the sole writer of PAID.
      expect(orderUpdate).not.toHaveBeenCalled();
      expect(paymentUpdate).not.toHaveBeenCalled();
    });

    it('records AMOUNT_MISMATCH and CURRENCY_MISMATCH from one read', async () => {
      given({ unresolved: [payment()] });
      retrievePayment.mockResolvedValue(
        providerPayment({ amountMinorUnits: 1, currency: 'EUR' }),
      );

      await service.run();

      expect(kinds()).toEqual(
        expect.arrayContaining(['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH']),
      );
    });

    it('records PROVIDER_PAYMENT_NOT_FOUND when the provider rejects with not-found', async () => {
      given({ unresolved: [payment()] });
      retrievePayment.mockRejectedValue(
        new ProviderPaymentNotFoundError('pi_1'),
      );

      const counts = await service.run();

      expect(kinds()).toEqual(['PROVIDER_PAYMENT_NOT_FOUND']);
      // Nothing malfunctioned: the provider answered. Same call as the expiry
      // sweep's, which counts not-found as skipped rather than failed.
      expect(counts.failed).toBe(0);
    });

    it('records PAID_ORDER_TERMINAL_UNPAYABLE with no provider call at all', async () => {
      given({
        refundOwed: [
          payment({
            status: PaymentStatus.SUCCEEDED,
            order: {
              status: OrderStatus.EXPIRED,
              totalCents: 9998,
              currency: 'USD',
            },
          }),
        ],
      });

      await service.run();

      expect(kinds()).toEqual(['PAID_ORDER_TERMINAL_UNPAYABLE']);
      expect(retrievePayment).not.toHaveBeenCalled();
    });

    it('raises PROVIDER_UNREACHABLE only at the configured consecutive threshold', async () => {
      given({ unresolved: [payment()] });
      retrievePayment.mockRejectedValue(new Error('socket hang up'));

      await service.run();
      await service.run();

      expect(kinds()).toEqual([]);

      const third = await service.run();

      expect(kinds()).toEqual(['PROVIDER_UNREACHABLE']);
      expect(third.failed).toBe(1);
    });

    it('clears the consecutive count once the provider answers again', async () => {
      given({ unresolved: [payment()] });
      retrievePayment.mockRejectedValue(new Error('socket hang up'));
      await service.run();
      await service.run();

      retrievePayment.mockResolvedValue(providerPayment());
      await service.run();

      retrievePayment.mockRejectedValue(new Error('socket hang up'));
      await service.run();

      expect(kinds()).toEqual([]);
    });
  });

  describe('resolution — candidate set 3 (spec §8.2)', () => {
    it('re-examines the orders of open findings even when no other set holds them', async () => {
      open.mockResolvedValue([
        openFinding('ord1', 'PROVIDER_SUCCESS_LOCAL_NOT_PAID'),
      ]);
      given({
        forOpen: [
          payment({
            status: PaymentStatus.SUCCEEDED,
            order: {
              status: OrderStatus.PAID,
              totalCents: 9998,
              currency: 'USD',
            },
          }),
        ],
      });

      const counts = await service.run();

      // A SUCCEEDED local payment falsifies "local not paid" with no provider
      // call, which is what lets the finding clear at all.
      expect(resolve).toHaveBeenCalledWith(
        'ord1',
        'PROVIDER_SUCCESS_LOCAL_NOT_PAID',
      );
      expect(retrievePayment).not.toHaveBeenCalled();
      expect(counts.affected).toBe(1);
    });

    it('resolves a mismatch once the provider and the order agree again', async () => {
      open.mockResolvedValue([openFinding('ord1', 'AMOUNT_MISMATCH')]);
      given({ unresolved: [payment()], forOpen: [payment()] });

      await service.run();

      expect(resolve).toHaveBeenCalledWith('ord1', 'AMOUNT_MISMATCH');
    });

    it('does NOT resolve a mismatch when the provider read failed', async () => {
      open.mockResolvedValue([openFinding('ord1', 'AMOUNT_MISMATCH')]);
      given({ unresolved: [payment()] });
      retrievePayment.mockRejectedValue(new Error('socket hang up'));

      await service.run();

      // Fail closed: an outage is not evidence that the money now agrees.
      expect(resolve).not.toHaveBeenCalled();
    });

    it('does NOT resolve a mismatch on a not-found, which decides nothing about amounts', async () => {
      open.mockResolvedValue([openFinding('ord1', 'AMOUNT_MISMATCH')]);
      given({ unresolved: [payment()] });
      retrievePayment.mockRejectedValue(
        new ProviderPaymentNotFoundError('pi_1'),
      );

      await service.run();

      expect(resolve).not.toHaveBeenCalledWith('ord1', 'AMOUNT_MISMATCH');
    });

    /**
     * The alertable number of spec §13 is COUNT(*) WHERE resolved_at IS NULL.
     * A failed read must never decrement it: only a read that ANSWERS proves
     * reachability. This fires after a restart, and whenever
     * pruneFailureCounters() has dropped the id, because the counter then
     * restarts below threshold while the outage continues.
     */
    it('does NOT resolve PROVIDER_UNREACHABLE on a failed read below threshold', async () => {
      open.mockResolvedValue([openFinding('ord1', 'PROVIDER_UNREACHABLE')]);
      given({ unresolved: [payment()], forOpen: [payment()] });
      retrievePayment.mockRejectedValue(new Error('socket hang up'));

      await service.run();

      expect(resolve).not.toHaveBeenCalled();
    });

    it('resolves PROVIDER_UNREACHABLE only once the provider answers', async () => {
      open.mockResolvedValue([openFinding('ord1', 'PROVIDER_UNREACHABLE')]);
      given({ unresolved: [payment()], forOpen: [payment()] });

      await service.run();

      expect(resolve).toHaveBeenCalledWith('ord1', 'PROVIDER_UNREACHABLE');
    });

    it('resolves PROVIDER_UNREACHABLE on a not-found, which also proves reachability', async () => {
      open.mockResolvedValue([openFinding('ord1', 'PROVIDER_UNREACHABLE')]);
      given({ unresolved: [payment()], forOpen: [payment()] });
      retrievePayment.mockRejectedValue(
        new ProviderPaymentNotFoundError('pi_1'),
      );

      await service.run();

      expect(resolve).toHaveBeenCalledWith('ord1', 'PROVIDER_UNREACHABLE');
    });

    it('resolves a refund-owed finding once the order leaves a terminal state', async () => {
      open.mockResolvedValue([
        openFinding('ord1', 'PAID_ORDER_TERMINAL_UNPAYABLE'),
      ]);
      given({
        forOpen: [
          payment({
            status: PaymentStatus.SUCCEEDED,
            order: {
              status: OrderStatus.PAID,
              totalCents: 9998,
              currency: 'USD',
            },
          }),
        ],
      });

      await service.run();

      expect(resolve).toHaveBeenCalledWith(
        'ord1',
        'PAID_ORDER_TERMINAL_UNPAYABLE',
      );
    });
  });

  describe('summary counts', () => {
    it('counts a clean candidate as skipped, not affected', async () => {
      given({ unresolved: [payment()] });

      const counts = await service.run();

      expect(counts).toEqual({
        examined: 1,
        affected: 0,
        skipped: 1,
        failed: 0,
      });
      expect(record).not.toHaveBeenCalled();
    });

    it('counts one candidate once even when three sets select it', async () => {
      const row = payment();

      open.mockResolvedValue([openFinding('ord1', 'AMOUNT_MISMATCH')]);
      given({ unresolved: [row], refundOwed: [row], forOpen: [row] });

      const counts = await service.run();

      expect(counts.examined).toBe(1);
      expect(retrievePayment).toHaveBeenCalledTimes(1);
    });
  });

  describe('a mass of not-founds is a configuration signal, not N divergences', () => {
    it('logs one error naming the key-mode cause when every read is not-found', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');

      given({
        unresolved: [
          payment({ id: 'p1', providerPaymentId: 'pi_1', orderId: 'o1' }),
          payment({ id: 'p2', providerPaymentId: 'pi_2', orderId: 'o2' }),
          payment({ id: 'p3', providerPaymentId: 'pi_3', orderId: 'o3' }),
        ],
      });
      retrievePayment.mockImplementation((id: string) =>
        Promise.reject(new ProviderPaymentNotFoundError(id)),
      );

      await service.run();

      const messages = error.mock.calls.map(([message]) => String(message));

      expect(messages.some((m) => /key-mode mismatch/.test(m))).toBe(true);
      // The per-order findings are still recorded: each names a real order.
      expect(kinds()).toEqual([
        'PROVIDER_PAYMENT_NOT_FOUND',
        'PROVIDER_PAYMENT_NOT_FOUND',
        'PROVIDER_PAYMENT_NOT_FOUND',
      ]);
    });

    it('stays quiet when only some reads are not-found', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');

      given({
        unresolved: [
          payment({ id: 'p1', providerPaymentId: 'pi_1', orderId: 'o1' }),
          payment({ id: 'p2', providerPaymentId: 'pi_2', orderId: 'o2' }),
          payment({ id: 'p3', providerPaymentId: 'pi_3', orderId: 'o3' }),
        ],
      });
      retrievePayment.mockImplementation((id: string) =>
        id === 'pi_1'
          ? Promise.resolve(providerPayment({ providerPaymentId: id }))
          : Promise.reject(new ProviderPaymentNotFoundError(id)),
      );

      await service.run();

      const messages = error.mock.calls.map(([message]) => String(message));

      expect(messages.some((m) => /key-mode mismatch/.test(m))).toBe(false);
    });
  });

  describe('detail never carries a payload or a secret (spec §8.4, §12)', () => {
    it('stores only ids, amounts, currencies, and timestamps', async () => {
      given({ unresolved: [payment()] });
      retrievePayment.mockResolvedValue(
        providerPayment({ amountMinorUnits: 1 }),
      );

      await service.run();

      const [, , , detail] = record.mock.calls[0];

      expect(Object.keys(detail as object).sort()).toEqual([
        'observedAt',
        'orderTotalCents',
        'providerAmountMinorUnits',
        'providerPaymentId',
      ]);
      expect(JSON.stringify(detail)).not.toMatch(/secret/i);
    });
  });
});
