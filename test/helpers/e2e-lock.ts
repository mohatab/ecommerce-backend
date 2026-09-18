import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Advisory lock id guarding the whole e2e database. Arbitrary but fixed —
 * every e2e run must ask for the same key or the guard is decorative.
 */
export const E2E_LOCK_KEY = 728374651n;

/**
 * `maxWorkers: 1` only serializes suites inside ONE Jest process. Nothing
 * stopped a second `npm run test:e2e` (another terminal, another agent, a CI
 * job) from sharing the single dockerized database on port 5433, and the two
 * runs then destroy each other: `truncateAll()` takes an AccessExclusiveLock
 * on every table while the other run holds row locks from an in-flight
 * request, which is a 40P01 deadlock, and the TRUNCATE that does succeed
 * deletes rows the other run's test just created (a product that 404s, a
 * category that raises P2003). Recorded in the Postgres log of the failing
 * run: `Process A: TRUNCATE TABLE ... RESTART IDENTITY CASCADE` against
 * `Process B: INSERT INTO "public"."cart_items" ... ON CONFLICT ...`.
 *
 * The lock is session-scoped, so a run that is killed or crashes releases it
 * when its connection drops; there is never a stale lock to clear by hand.
 */
const store = globalThis as typeof globalThis & {
  e2eDatabaseLockHolder?: PrismaService;
};

export async function acquireE2eDatabaseLock(
  databaseUrl: string,
): Promise<void> {
  const prisma = new PrismaService({ datasourceUrl: databaseUrl });

  await prisma.$connect();

  const [{ locked }] = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${E2E_LOCK_KEY}) AS locked
  `;

  if (!locked) {
    await prisma.$disconnect();

    throw new Error(
      'Another e2e run already holds the test database. Concurrent runs ' +
        'truncate each other’s rows mid-test — wait for the other run ' +
        'to finish, or point TEST_DATABASE_URL at a database of your own.',
    );
  }

  store.e2eDatabaseLockHolder = prisma;
}

/** Disconnecting ends the session, which is what releases the lock. */
export async function releaseE2eDatabaseLock(): Promise<void> {
  const prisma = store.e2eDatabaseLockHolder;

  if (!prisma) {
    return;
  }

  store.e2eDatabaseLockHolder = undefined;
  await prisma.$disconnect();
}
