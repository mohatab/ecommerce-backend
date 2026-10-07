import { config } from 'dotenv';

config();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Copy .env.example to .env, then run: docker compose up -d postgres-test',
  );
}

process.env.DATABASE_URL = testDatabaseUrl;

// No background maintenance tick may race a test's assertions (spec §14.7).
// Every suite drives jobs through MaintenanceRunnerService.run() directly, so
// nothing here needs a registered cron. This is also why the master switch
// exists at all.
process.env.MAINTENANCE_JOBS_ENABLED = 'false';
