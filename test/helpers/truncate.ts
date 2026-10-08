import { PrismaService } from '../../src/prisma/prisma.service';

interface TableRow {
  tablename: string;
}

export async function truncateAll(prisma: PrismaService): Promise<void> {
  // Concurrency suites open many simultaneous transactions against these tables;
  // an unordered pg_tables result lets two TRUNCATEs grab lock order differently,
  // producing a 40P01 deadlock that would be indistinguishable from a real defect.
  const tables = await prisma.$queryRaw<TableRow[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
      -- maintenance_leases is seeded by migration and holds no test data.
      -- Truncating it would leave acquire() matching zero rows forever, so
      -- every job would report skipped:'lease-missing' — the error-level
      -- operational-fault branch, NOT 'lease-held' — and no e2e job would ever
      -- run again until the rows were restored by a migration reset.
      -- resetLeases() does not repair that: it is updateMany-only, so it frees
      -- a lease a test left held and never recreates a row.
      AND tablename <> 'maintenance_leases'
    ORDER BY tablename
  `;

  if (tables.length === 0) {
    return;
  }

  const quoted = tables
    .map((table) => `"public"."${table.tablename}"`)
    .join(', ');

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`,
  );
}
