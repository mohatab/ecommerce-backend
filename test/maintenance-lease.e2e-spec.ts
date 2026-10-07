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

  it('rolls back a write already made before the fence failed', async () => {
    // The discriminating case. In the test above the mutation follows
    // assertHeld, so a fencing check made in a SEPARATE call before the
    // transaction would leave stock untouched too and the test would pass for
    // the wrong reason. Here the write happens first, so the only thing that
    // can leave 5 in the database is the transaction actually rolling back —
    // which is only possible because the check shares that transaction.
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
