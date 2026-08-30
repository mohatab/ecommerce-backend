import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** The plaintext every factory-created user authenticates with. */
export const TEST_PASSWORD = 'Test1234!';

/**
 * A precomputed argon2id digest of TEST_PASSWORD. Hashing per fixture would
 * add ~50-100ms to every test that needs a user; argon2 is deliberately slow.
 * Regenerate with:
 *   node -e "require('@node-rs/argon2').hash('Test1234!').then(console.log)"
 */
export const TEST_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$aTamFzUDCpAT22xy1imxTA$9TVpJxHAGgaZ88HzaMY2eWDv5YRtZksheMSqjVExC5A';

/**
 * Safe ONLY because the e2e suite is serial (`maxWorkers: 1` in
 * test/jest-e2e.json). Do not reuse this pattern if per-worker isolation is
 * ever added — parallel workers would hand out colliding emails.
 *
 * Note it resets to 0 for every spec file, because Jest gives each file its
 * own module registry. `users.email` is @unique, so two spec files that each
 * create `user1@example.test` without truncating in between will collide with
 * P2002. Suites using this factory should call `truncateAll()` in `beforeEach`.
 */
let sequence = 0;

export async function createUser(
  prisma: PrismaService,
  overrides: Partial<Prisma.UserCreateInput> = {},
): Promise<User> {
  sequence += 1;

  return prisma.user.create({
    data: {
      email: `user${sequence}@example.test`,
      passwordHash: TEST_PASSWORD_HASH,
      role: Role.CUSTOMER,
      ...overrides,
    },
  });
}
