import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Frees every maintenance lease. Call in beforeEach alongside truncateAll():
 * truncateAll() deliberately does not touch maintenance_leases, so a test that
 * leaves a lease held would otherwise block the next test's job.
 */
export async function resetLeases(prisma: PrismaService): Promise<void> {
  await prisma.maintenanceLease.updateMany({
    data: { holder: '', expiresAt: new Date(0) },
  });
}
