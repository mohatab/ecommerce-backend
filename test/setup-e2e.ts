import { config } from 'dotenv';

config();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Copy .env.example to .env, then run: docker compose up -d postgres-test',
  );
}

process.env.DATABASE_URL = testDatabaseUrl;
