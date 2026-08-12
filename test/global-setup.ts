import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';

config();

export default function globalSetup(): void {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (!testDatabaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env, then run: docker compose up -d postgres-test',
    );
  }

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
