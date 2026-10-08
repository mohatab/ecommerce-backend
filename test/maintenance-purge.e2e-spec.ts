import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { App } from 'supertest/types';
import { AppConfig } from '../src/config/configuration';
import { MaintenanceJobName } from '../src/modules/maintenance/maintenance-job-name.enum';
import { MaintenanceRunnerService } from '../src/modules/maintenance/maintenance-runner.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createPaymentEvent } from './factories/payment-event.factory';
import { createUser } from './factories/user.factory';
import { createTestApp } from './helpers/create-test-app';
import { resetLeases } from './helpers/reset-leases';
import { truncateAll } from './helpers/truncate';

const DAY_MS = 86_400_000;
const ago = (days: number): Date => new Date(Date.now() - days * DAY_MS);
const fromNow = (days: number): Date => new Date(Date.now() + days * DAY_MS);

describe('Maintenance purge (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let runner: MaintenanceRunnerService;
  let user: User;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    runner = app.get(MaintenanceRunnerService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await resetLeases(prisma);
    user = await createUser(prisma);
  });

  // No createRefreshToken factory exists; rows go through the Prisma client.
  function token(
    expiresAt: Date,
    extra: { createdAt?: Date; revokedAt?: Date } = {},
  ): Promise<{ id: string }> {
    seq += 1;
    return prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: `hash_${seq}`,
        familyId: `family_${seq}`,
        expiresAt,
        ...extra,
      },
    });
  }

  const exists = async (id: string): Promise<boolean> =>
    (await prisma.refreshToken.findUnique({ where: { id } })) !== null;

  it('deletes refresh tokens whose expiry is past the cutoff, keeps recent ones', async () => {
    const stale = await token(ago(31));
    const recent = await token(ago(1));

    await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

    expect(await exists(stale.id)).toBe(false);
    expect(await exists(recent.id)).toBe(true);
  });

  it('never deletes a live refresh token, however old its createdAt', async () => {
    // Old createdAt + future expiresAt: a cutoff written against createdAt
    // would delete this row, so only an expiresAt cutoff passes.
    const live = await token(fromNow(1), { createdAt: ago(400) });

    await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

    expect(await exists(live.id)).toBe(true);
  });

  it('keeps a revoked-but-unexpired token (reuse-detection evidence)', async () => {
    const revoked = await token(fromNow(1), {
      createdAt: ago(400),
      revokedAt: ago(300),
    });

    await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

    expect(await exists(revoked.id)).toBe(true);
  });

  it('deletes payment events past the retention cutoff only', async () => {
    const old = await createPaymentEvent(prisma, undefined, {
      createdAt: ago(91),
    });
    const fresh = await createPaymentEvent(prisma, undefined, {
      createdAt: ago(1),
    });

    await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

    expect(
      await prisma.paymentEvent.findUnique({ where: { id: old.id } }),
    ).toBeNull();
    expect(
      await prisma.paymentEvent.findUnique({ where: { id: fresh.id } }),
    ).not.toBeNull();
  });

  it('is idempotent: a second run deletes nothing more', async () => {
    await token(ago(31));
    await createPaymentEvent(prisma, undefined, { createdAt: ago(91) });

    const first = await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);
    const second = await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

    expect(first.affected).toBe(2);
    expect(second.affected).toBe(0);
  });

  it('is bounded by the batch size, oldest first', async () => {
    const batch = app
      .get<ConfigService<AppConfig, true>>(ConfigService)
      .get('maintenance.purgeBatchSize', { infer: true });
    const n = batch + 3;
    await prisma.refreshToken.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        userId: user.id,
        tokenHash: `bulk_${i}`,
        familyId: `bulk_family_${i}`,
        expiresAt: ago(40 + i),
      })),
    });

    const first = await runner.run(MaintenanceJobName.MAINTENANCE_PURGE);

    expect(first.affected).toBe(batch);
    // Largest i = oldest expiry; the three survivors are the newest.
    const left = await prisma.refreshToken.findMany({
      orderBy: { tokenHash: 'asc' },
    });
    expect(left.map((r) => r.tokenHash)).toEqual([
      'bulk_0',
      'bulk_1',
      'bulk_2',
    ]);
  });
});
