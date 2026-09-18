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
