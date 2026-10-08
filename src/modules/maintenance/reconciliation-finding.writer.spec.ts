import { PrismaService } from '../../prisma/prisma.service';
import { ReconciliationFindingWriter } from './reconciliation-finding.writer';

interface UpsertArgs {
  where: { orderId_kind: { orderId: string; kind: string } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}
interface UpdateManyArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}
interface FindManyArgs {
  where: Record<string, unknown>;
  orderBy: unknown;
  skip?: number;
  take?: number;
}

type Upsert = jest.Mock<Promise<unknown>, [UpsertArgs]>;
type UpdateMany = jest.Mock<Promise<{ count: number }>, [UpdateManyArgs]>;
type FindMany = jest.Mock<Promise<unknown[]>, [FindManyArgs]>;
type Count = jest.Mock<Promise<number>, [{ where: Record<string, unknown> }]>;

/**
 * The SHAPE of the three lifecycle writes, asserted against a mock. That the
 * semantics actually hold in PostgreSQL — one row, counters advancing,
 * firstSeenAt never rewritten — is proven in
 * test/payment-reconciliation.e2e-spec.ts, because only a real unique index
 * can prove a duplicate is prevented.
 */
describe('ReconciliationFindingWriter', () => {
  let writer: ReconciliationFindingWriter;
  let finding: {
    upsert: Upsert;
    updateMany: UpdateMany;
    findMany: FindMany;
    count: Count;
  };

  beforeEach(() => {
    finding = {
      upsert: jest.fn<Promise<unknown>, [UpsertArgs]>().mockResolvedValue({}),
      updateMany: jest
        .fn<Promise<{ count: number }>, [UpdateManyArgs]>()
        .mockResolvedValue({ count: 1 }),
      findMany: jest
        .fn<Promise<unknown[]>, [FindManyArgs]>()
        .mockResolvedValue([]),
      count: jest
        .fn<Promise<number>, [{ where: Record<string, unknown> }]>()
        .mockResolvedValue(0),
    };
    writer = new ReconciliationFindingWriter({
      reconciliationFinding: finding,
    } as unknown as PrismaService);
  });

  describe('record', () => {
    it('upserts on (orderId, kind) rather than creating', async () => {
      await writer.record('o1', 'p1', 'AMOUNT_MISMATCH', { a: 1 });

      const [args] = finding.upsert.mock.calls[0];

      expect(args.where.orderId_kind).toEqual({
        orderId: 'o1',
        kind: 'AMOUNT_MISMATCH',
      });
    });

    it('creates with occurrences 1, firstSeenAt set, and no resolvedAt', async () => {
      await writer.record('o1', 'p1', 'AMOUNT_MISMATCH', { a: 1 });

      const [args] = finding.upsert.mock.calls[0];

      expect(args.create.occurrences).toBe(1);
      expect(args.create.firstSeenAt).toEqual(args.create.lastSeenAt);
      expect(args.create.resolvedAt).toBeUndefined();
    });

    it('increments occurrences and never rewrites firstSeenAt on update', async () => {
      await writer.record('o1', 'p1', 'AMOUNT_MISMATCH', { a: 1 });

      const [args] = finding.upsert.mock.calls[0];

      expect(args.update.occurrences).toEqual({ increment: 1 });
      // The audit value. A `firstSeenAt` here would turn "since <date>" into
      // "since the last clear".
      expect(args.update.firstSeenAt).toBeUndefined();
      expect(args.update.resolvedAt).toBeNull();
      expect(args.update.detail).toEqual({ a: 1 });
    });
  });

  describe('resolve', () => {
    it('claims only an unresolved row and leaves the counters alone', async () => {
      await writer.resolve('o1', 'AMOUNT_MISMATCH');

      const [args] = finding.updateMany.mock.calls[0];

      expect(args.where).toEqual({
        orderId: 'o1',
        kind: 'AMOUNT_MISMATCH',
        resolvedAt: null,
      });
      expect(Object.keys(args.data)).toEqual(['resolvedAt']);
    });

    it('reports false when nothing was open to resolve', async () => {
      finding.updateMany.mockResolvedValue({ count: 0 });

      await expect(writer.resolve('o1', 'AMOUNT_MISMATCH')).resolves.toBe(
        false,
      );
    });
  });

  describe('list', () => {
    it('filters to resolvedAt null by default and orders deterministically', async () => {
      await writer.list({ resolved: false, skip: 0, take: 20 });

      const [args] = finding.findMany.mock.calls[0];

      expect(args.where.resolvedAt).toBeNull();
      expect(args.orderBy).toEqual([{ lastSeenAt: 'desc' }, { id: 'desc' }]);
    });

    it('selects resolved rows with a not-null predicate when asked', async () => {
      await writer.list({ resolved: true, skip: 0, take: 20 });

      const [args] = finding.findMany.mock.calls[0];

      expect(args.where.resolvedAt).toEqual({ not: null });
    });

    it('omits the kind filter entirely when no kind was given', async () => {
      await writer.list({ resolved: false, skip: 0, take: 20 });

      const [args] = finding.findMany.mock.calls[0];

      expect('kind' in args.where).toBe(false);
    });
  });
});
