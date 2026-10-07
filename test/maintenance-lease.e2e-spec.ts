import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App } from 'supertest/types';
import { MaintenanceJobName } from '../src/modules/maintenance/maintenance-job-name.enum';
import {
  LeaseLostError,
  MaintenanceLeaseService,
} from '../src/modules/maintenance/maintenance-lease.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { createTestApp } from './helpers/create-test-app';
import { resetLeases } from './helpers/reset-leases';
import { truncateAll } from './helpers/truncate';

/**
 * Spec §9.3.6 tests 1-3. These run against real PostgreSQL because the whole
 * claim is about database-level exclusion: a mocked Prisma client would only
 * prove the service calls the methods it was written to call.
 */
describe('MaintenanceLease exclusion (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await resetLeases(prisma);
  });

  /** Two instances == two services with different instanceIds, one database. */
  function newInstance(): MaintenanceLeaseService {
    return new MaintenanceLeaseService(prisma, app.get(ConfigService));
  }

  it('lets exactly one of two instances acquire the same lease', async () => {
    const a = newInstance();
    const b = newInstance();

    expect(a.instanceId).not.toBe(b.instanceId);

    const [first, second] = await Promise.all([
      a.acquire(MaintenanceJobName.ORDER_EXPIRY),
      b.acquire(MaintenanceJobName.ORDER_EXPIRY),
    ]);

    expect([first, second].filter((r) => r === 'acquired')).toHaveLength(1);
    expect([first, second].filter((r) => r === 'held')).toHaveLength(1);
  });

  it('does not let a second lease on one job block a different job', async () => {
    // Per-job rows, not one shared row: a slow reconciliation pass must not
    // block order expiry.
    const a = newInstance();

    expect(await a.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');
    expect(
      await newInstance().acquire(MaintenanceJobName.MAINTENANCE_PURGE),
    ).toBe('acquired');
  });

  it('refuses a heartbeat after another instance takes the lease over', async () => {
    const a = newInstance();
    const b = newInstance();
    expect(await a.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');
    expect(await a.heartbeat(MaintenanceJobName.ORDER_EXPIRY)).toBe(true);

    // Force A's lease to lapse, then let B take it. Stands in for A being
    // paused (GC, container freeze) for longer than the lease.
    await prisma.maintenanceLease.update({
      where: { job: MaintenanceJobName.ORDER_EXPIRY },
      data: { expiresAt: new Date(0) },
    });
    expect(await b.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');

    expect(await a.heartbeat(MaintenanceJobName.ORDER_EXPIRY)).toBe(false);
    // And A's release must not free B's lease.
    await a.release(MaintenanceJobName.ORDER_EXPIRY);
    expect(await newInstance().acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe(
      'held',
    );
  });

  it('rolls back a transaction whose lease was taken over (fencing)', async () => {
    const a = newInstance();
    const b = newInstance();
    expect(await a.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');
    await prisma.maintenanceLease.update({
      where: { job: MaintenanceJobName.ORDER_EXPIRY },
      data: { expiresAt: new Date(0) },
    });
    expect(await b.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');

    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await a.assertHeld(tx, MaintenanceJobName.ORDER_EXPIRY);
        await tx.product.update({
          where: { id: product.id },
          data: { stockQuantity: 999 },
        });
      }),
    ).rejects.toThrow(LeaseLostError);

    // The guarantee that matters: nothing was committed. A fencing check in a
    // separate call before the transaction would leave 999 here.
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(5);
  });

  it('rolls back the fence own heartbeat write, so the check is INSIDE the transaction', async () => {
    // THE control for the same-transaction invariant, and the only test in
    // this file that discriminates on it.
    //
    // Every other test here passes even when assertHeld is patched to use
    // `this.prisma` instead of `tx` — verified empirically, all 8 of them —
    // because the throw happens inside the $transaction callback either way
    // and Prisma rolls the outer transaction back regardless of which
    // connection the check ran on.
    //
    // assertHeld's OWN write is the observable difference. It bumps
    // heartbeatAt, so:
    //   with `tx`          -> the bump is part of the transaction and ROLLS BACK
    //   with `this.prisma` -> it lands on a separate autocommit connection and
    //                         COMMITS even though the transaction rolled back
    //
    // The lease is held and unexpired here, so assertHeld SUCCEEDS; the
    // transaction then fails for an unrelated reason. heartbeatAt must be
    // untouched afterwards.
    const a = newInstance();
    expect(await a.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');

    // Pinned to the epoch rather than read back from acquire(): heartbeat_at
    // is TIMESTAMP(3), and a bump landing in the same millisecond as the
    // acquire would make the assertion silently vacuous. expiresAt stays in
    // the future so the fence passes.
    const pinned = new Date(0);
    await prisma.maintenanceLease.update({
      where: { job: MaintenanceJobName.ORDER_EXPIRY },
      data: { heartbeatAt: pinned, expiresAt: new Date(Date.now() + 600_000) },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await a.assertHeld(tx, MaintenanceJobName.ORDER_EXPIRY);
        throw new Error('unrelated failure after a successful fence');
      }),
    ).rejects.toThrow('unrelated failure after a successful fence');

    const lease = await prisma.maintenanceLease.findUniqueOrThrow({
      where: { job: MaintenanceJobName.ORDER_EXPIRY },
    });

    // Fails exactly when the fence ran outside the caller's transaction.
    expect(lease.heartbeatAt).toEqual(pinned);
  });

  it('rolls back a write already made before the fence failed', async () => {
    // Rules out a fencing check made in a SEPARATE CALL BEFORE the
    // transaction: in the test above the mutation follows assertHeld, so such
    // a check would throw before the write ever ran and leave stock untouched
    // too. Here the write happens first, so only an actual rollback can leave
    // 5 in the database.
    //
    // It does NOT rule out a check made outside the transaction on another
    // connection — the throw still unwinds the callback and Prisma still rolls
    // back. That case is covered by the heartbeat control above, and by this
    // file's first test only in combination with it.
    const a = newInstance();
    const b = newInstance();
    expect(await a.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');
    await prisma.maintenanceLease.update({
      where: { job: MaintenanceJobName.ORDER_EXPIRY },
      data: { expiresAt: new Date(0) },
    });
    expect(await b.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');

    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: product.id },
          data: { stockQuantity: 999 },
        });
        await a.assertHeld(tx, MaintenanceJobName.ORDER_EXPIRY);
      }),
    ).rejects.toThrow(LeaseLostError);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(5);
  });

  it('lets the holder commit a mutation inside the fenced transaction', async () => {
    // The other half of the fencing test: assertHeld must not block the
    // instance that legitimately holds the lease, or every sweep would roll
    // back and the suite above would pass for the wrong reason.
    const a = newInstance();
    expect(await a.acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe('acquired');

    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });

    await prisma.$transaction(async (tx) => {
      await a.assertHeld(tx, MaintenanceJobName.ORDER_EXPIRY);
      await tx.product.update({
        where: { id: product.id },
        data: { stockQuantity: 7 },
      });
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(7);
  });

  it('survives truncateAll, so e2e jobs are not silently skipped', async () => {
    await truncateAll(prisma);

    const rows = await prisma.maintenanceLease.count();
    expect(rows).toBe(3);
    expect(await newInstance().acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe(
      'acquired',
    );
  });

  it('reports missing, not held, when the lease row is absent', async () => {
    // A deleted row makes the job unrunnable forever; 'held' would hide that
    // behind the same routine warn a normal contended tick produces.
    await prisma.maintenanceLease.delete({
      where: { job: MaintenanceJobName.ORDER_EXPIRY },
    });

    try {
      expect(await newInstance().acquire(MaintenanceJobName.ORDER_EXPIRY)).toBe(
        'missing',
      );
    } finally {
      // Restore what the migration seeded; truncateAll() will not.
      await prisma.maintenanceLease.create({
        data: {
          job: MaintenanceJobName.ORDER_EXPIRY,
          holder: '',
          acquiredAt: new Date(0),
          heartbeatAt: new Date(0),
          expiresAt: new Date(0),
        },
      });
    }
  });
});
