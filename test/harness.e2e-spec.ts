import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './helpers/truncate';
import { E2E_LOCK_KEY } from './helpers/e2e-lock';

describe('e2e harness', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS harness_probe');
    await prisma.$disconnect();
  });

  it('connects to the test database, not the development one', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ current_database: string }>
    >`SELECT current_database()`;

    expect(rows[0].current_database).toBe('ecommerce_test');
  });

  it('truncateAll empties every public table', async () => {
    await prisma.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS harness_probe (id serial PRIMARY KEY, label text)',
    );
    await prisma.$executeRawUnsafe(
      "INSERT INTO harness_probe (label) VALUES ('a'), ('b')",
    );

    await truncateAll(prisma);

    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM harness_probe',
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it('holds the whole-run database lock, so a second e2e run cannot start', async () => {
    // globalSetup took this lock on a connection of its own and holds it
    // until globalTeardown. Without it, two overlapping `npm run test:e2e`
    // processes share one database and each one's truncateAll() deadlocks
    // against — and deletes the rows of — the other's in-flight tests.
    // A rival session must therefore be refused here.
    const rival = new PrismaService();

    try {
      await rival.$connect();

      const [{ locked }] = await rival.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_lock(${E2E_LOCK_KEY}) AS locked
      `;

      expect(locked).toBe(false);
    } finally {
      // Ends the rival session, releasing the lock again if this test ever
      // does acquire one — a failure must not poison the rest of the run.
      await rival.$disconnect();
    }
  });

  it('truncateAll succeeds when there are no tables', async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS harness_probe');

    await expect(truncateAll(prisma)).resolves.toBeUndefined();
  });
});
