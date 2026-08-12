import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './helpers/truncate';

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

  it('truncateAll succeeds when there are no tables', async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS harness_probe');

    await expect(truncateAll(prisma)).resolves.toBeUndefined();
  });
});
