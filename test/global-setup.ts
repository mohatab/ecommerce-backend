import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { acquireE2eDatabaseLock } from './helpers/e2e-lock';

config();

export default async function globalSetup(): Promise<void> {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (!testDatabaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env, then run: docker compose up -d postgres-test',
    );
  }

  // Before the migration, not after: two runs racing `migrate deploy` is the
  // same collision one step earlier. Released in global-teardown.ts.
  await acquireE2eDatabaseLock(testDatabaseUrl);

  const migrationsDir = join(__dirname, '..', 'prisma', 'migrations');
  const hasMigrations =
    existsSync(migrationsDir) &&
    readdirSync(migrationsDir).some(
      (entry) => !entry.startsWith('.') && entry !== 'migration_lock.toml',
    );

  if (!hasMigrations) {
    console.log('[e2e] No migrations found — skipping prisma migrate deploy.');
    return;
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}
