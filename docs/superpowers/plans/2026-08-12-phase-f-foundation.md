# Phase F — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cross-cutting primitives every later phase depends on — URI versioning, shared app configuration, Prisma error mapping, pagination contracts, an isolated e2e test harness, and CI — so Phase 1 (authentication) starts on finished foundations.

**Architecture:** Application configuration is extracted from `main.ts` into a reusable `configureApp()` so runtime and tests apply byte-identical setup. Routes move under `/api/v1/*` with `/health` deliberately excluded from both prefix and versioning. Cross-cutting primitives live in `src/common/` and contain no domain logic. E2E tests run against a dedicated throwaway Postgres on port 5433, truncated between tests.

**Tech Stack:** NestJS 11, Prisma 6.19.3, PostgreSQL 16, Jest 30 + Supertest, TypeScript 5.7 (strict), class-validator/class-transformer, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-12-foundation-architecture-design.md`
**Branch:** `phase-f/foundation`

## Global Constraints

- **No domain models.** Phase F adds zero Prisma models and zero migrations. `User` arrives in Phase 1.
- **Strict TypeScript.** `strict: true`, `noUnusedLocals`, `noUnusedParameters`. Avoid `any`; if unavoidable, comment why.
- **Public methods have explicit return types.**
- **`src/config/` is the only place `src/` reads `process.env`.** The e2e harness under `test/` is exempt — it reads `TEST_DATABASE_URL` directly, because it configures the environment before the app boots.
- **`src/common/` is cross-cutting only** — filters, guards, pipes, decorators, shared DTOs. Never domain logic.
- **Every new env var** goes into `.env.example` *and* the Joi schema in `src/config/env.validation.ts` in the same commit.
- **Never loosen `tsconfig.json` or disable an ESLint rule** to make an error go away.
- **Before any task is done:** `npm run lint`, `npm run build`, `npm test` must pass. `npm run test:e2e` additionally for DB-dependent changes.
- **Prerequisite for all e2e work:** Docker Desktop must be running. Start databases with `docker compose up -d`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/bootstrap.ts` | `configureApp()` — all app-level middleware/pipes/filters/versioning, shared by runtime and tests |
| `src/common/dto/pagination-query.dto.ts` | `PaginationQueryDto` — validated `page`/`limit` query input |
| `src/common/dto/paginated.dto.ts` | `PaginatedDto<T>`, `PaginationMetaDto` — list response envelope |
| `src/common/swagger/api-paginated-response.decorator.ts` | `@ApiPaginatedResponse(Model)` — Swagger schema for generic paginated responses |
| `test/global-setup.ts` | Jest globalSetup — points at the test DB, applies migrations if any exist |
| `test/setup-e2e.ts` | Per-worker setup — sets `DATABASE_URL` from `TEST_DATABASE_URL` before any import reads it |
| `test/helpers/truncate.ts` | `truncateAll()` — empties all public tables between tests |
| `test/helpers/create-test-app.ts` | `createTestApp()` — boots a Nest app with production configuration |
| `test/fixtures/ping.module.ts` | Fixture controller used to prove versioning and validation behaviour |
| `.github/workflows/ci.yml` | Lint → build → unit → e2e against a Postgres service container |

**Modified:**

| File | Change |
|---|---|
| `src/main.ts` | Delegates to `configureApp()`; keeps only Swagger and `listen()` |
| `src/modules/health/health.controller.ts` | Becomes version-neutral so `/health` stays unversioned |
| `src/common/filters/http-exception.filter.ts` | Adds Prisma known-error mapping |
| `src/config/env.validation.ts` | Adds optional `TEST_DATABASE_URL` |
| `test/jest-e2e.json` | Adds `globalSetup` and `setupFilesAfterEnv` |
| `test/app.e2e-spec.ts` | Uses `createTestApp()` so it exercises real configuration |
| `docker-compose.yml` | Adds `postgres-test` service on port 5433 |
| `package.json` | Adds `dotenv` dev dependency (Task 1) and `lint:ci` script (Task 6) |
| `.env.example`, `README.md`, `CLAUDE.md` | Document new conventions |

---

## Task 1: Isolated e2e test database harness

Goes first so every later task's e2e tests run against a throwaway database instead of the dev one.

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `src/config/env.validation.ts`
- Modify: `test/jest-e2e.json`
- Create: `test/global-setup.ts`
- Create: `test/setup-e2e.ts`
- Create: `test/helpers/truncate.ts`
- Test: `test/harness.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService` from `src/prisma/prisma.service.ts`
- Produces: `truncateAll(prisma: PrismaService): Promise<void>` — used by every later e2e test to reset state.

- [ ] **Step 1: Add the test database service**

In `docker-compose.yml`, add a second service under `services:` (leave `postgres` and the `volumes:` block untouched). It uses `tmpfs` rather than a volume — test data should never survive a restart, and RAM-backed storage makes truncation fast.

```yaml
  postgres-test:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ecommerce_test
    ports:
      - '5433:5432'
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      timeout: 5s
      retries: 5
```

- [ ] **Step 2: Declare the new env var**

Append to `.env.example`:

```
# Test database (used by the e2e harness only, never by the running app)
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ecommerce_test
```

Add the same line to your local `.env`.

In `src/config/env.validation.ts`, add to the Joi object:

```ts
  TEST_DATABASE_URL: Joi.string().uri().optional(),
```

It is `optional()` because production must boot without it. It is declared anyway so `forbidUnknown`-style drift between `.env.example` and the schema stays impossible.

- [ ] **Step 3: Start the databases and verify**

```bash
docker compose up -d
docker compose ps
```

Expected: both `postgres` and `postgres-test` show state `running (healthy)`. If Docker Desktop is not running, start it first — every later step in this task needs it.

- [ ] **Step 4: Install dotenv as an explicit dev dependency**

Jest does not load `.env` — `@nestjs/config` does that at app boot, which is far too late for the harness. The test setup files must load it themselves. `dotenv` is already present transitively via `@nestjs/config`, but the harness depends on it directly, so declare it directly rather than relying on a hoisted transitive.

```bash
npm install --save-dev dotenv
```

- [ ] **Step 5: Write the per-worker setup file**

Create `test/setup-e2e.ts`. This runs inside each Jest worker after the test framework is installed but before the test module is imported — the only reliable place to redirect the database connection. `dotenv` never overwrites an already-set variable, so this assignment also wins over `.env` inside the application.

```ts
import { config } from 'dotenv';

config();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Copy .env.example to .env, then run: docker compose up -d postgres-test',
  );
}

process.env.DATABASE_URL = testDatabaseUrl;
```

- [ ] **Step 6: Write the global setup file**

Create `test/global-setup.ts`. It applies migrations once per run. Phase F has no migrations yet, so it checks before shelling out — `prisma migrate deploy` against an empty migrations directory is not a behaviour worth depending on. It loads `.env` for the same reason `setup-e2e.ts` does: this runs in Jest's main process, where nothing has loaded it.

```ts
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
```

- [ ] **Step 7: Wire both files into the e2e Jest config**

Replace `test/jest-e2e.json` with:

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  },
  "globalSetup": "<rootDir>/global-setup.ts",
  "setupFilesAfterEnv": ["<rootDir>/setup-e2e.ts"]
}
```

- [ ] **Step 8: Write the failing test**

Create `test/harness.e2e-spec.ts`. It creates a real table, fills it, truncates, and asserts emptiness — and separately asserts the connection actually points at the test database, which is the failure that would otherwise silently wipe your dev data.

```ts
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
    const rows =
      await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;

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
```

- [ ] **Step 9: Run it to verify it fails**

```bash
npm run test:e2e -- harness
```

Expected: FAIL — `Cannot find module './helpers/truncate'`.

- [ ] **Step 10: Implement the truncate helper**

Create `test/helpers/truncate.ts`. It reads table names from `pg_tables` rather than a hardcoded list, so it keeps working as every future phase adds models — and it skips Prisma's own migration bookkeeping table.

```ts
import { PrismaService } from '../../src/prisma/prisma.service';

interface TableRow {
  tablename: string;
}

export async function truncateAll(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<TableRow[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
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
```

- [ ] **Step 11: Run the tests to verify they pass**

```bash
npm run test:e2e -- harness
```

Expected: PASS, 3 tests. The console shows `[e2e] No migrations found — skipping prisma migrate deploy.`

- [ ] **Step 12: Verify nothing else regressed**

```bash
npm run lint
npm run build
npm test
```

Expected: all pass. Note `npm run test:e2e` as a whole will still run `app.e2e-spec.ts` against the now-empty test database; `/health` only issues `SELECT 1`, so it still passes.

- [ ] **Step 13: Commit**

```bash
git add docker-compose.yml .env.example src/config/env.validation.ts \
        package.json package-lock.json \
        test/jest-e2e.json test/global-setup.ts test/setup-e2e.ts \
        test/helpers/truncate.ts test/harness.e2e-spec.ts
git commit -m "test: add isolated e2e database harness with truncation"
```

---

## Task 2: Shared app configuration, URI versioning, strict validation

**Files:**
- Create: `src/bootstrap.ts`
- Create: `test/helpers/create-test-app.ts`
- Create: `test/fixtures/ping.module.ts`
- Modify: `src/main.ts`
- Modify: `src/modules/health/health.controller.ts`
- Modify: `test/app.e2e-spec.ts`
- Test: `test/routing.e2e-spec.ts`

**Interfaces:**
- Consumes: `truncateAll` (Task 1), `HttpExceptionFilter`, `AppConfig`, `PrismaService`
- Produces:
  - `configureApp(app: INestApplication): void` — applies helmet, CORS, global prefix, URI versioning, `ValidationPipe`, exception filter, shutdown hooks.
  - `createTestApp(extraImports?: ModuleMetadata['imports']): Promise<INestApplication>` — used by every later e2e test.

- [ ] **Step 1: Write the failing routing test**

Create `test/routing.e2e-spec.ts`. It pins down all four routing rules and all three `ValidationPipe` behaviours, using a fixture controller so it does not depend on any domain module existing.

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { PingModule } from './fixtures/ping.module';

describe('routing and validation (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp([PingModule]);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('routing', () => {
    it('serves /health unprefixed and unversioned', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('does not serve health under the versioned prefix', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(404);
    });

    it('serves normal controllers under /api/v1', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ping')
        .expect(200)
        .expect({ pong: true });
    });

    it('does not serve normal controllers without the prefix', async () => {
      await request(app.getHttpServer()).get('/ping').expect(404);
    });

    it('does not serve normal controllers without a version', async () => {
      await request(app.getHttpServer()).get('/api/ping').expect(404);
    });
  });

  describe('validation pipe', () => {
    it('transforms declared query params to their target type', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ping/echo?limit=5')
        .expect(200)
        .expect({ limit: 5, limitType: 'number' });
    });

    it('rejects a non-numeric value instead of coercing it', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ping/echo?limit=abc')
        .expect(400);
    });

    it('rejects unknown query params', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/ping/echo?limit=5&sneaky=1')
        .expect(400);
    });

    it('returns the standard error shape', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/ping/echo?limit=abc')
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        error: expect.any(String) as string,
        timestamp: expect.any(String) as string,
        path: '/api/v1/ping/echo?limit=abc',
      });
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:e2e -- routing
```

Expected: FAIL — `Cannot find module './helpers/create-test-app'`.

- [ ] **Step 3: Create the fixture module**

Create `test/fixtures/ping.module.ts`. `limitType` is returned so the test can prove transformation produced a real number rather than a numeric-looking string.

```ts
import { Controller, Get, Module, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class EchoQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit!: number;
}

@Controller('ping')
export class PingController {
  @Get()
  ping(): { pong: true } {
    return { pong: true };
  }

  @Get('echo')
  echo(@Query() query: EchoQueryDto): { limit: number; limitType: string } {
    return { limit: query.limit, limitType: typeof query.limit };
  }
}

@Module({ controllers: [PingController] })
export class PingModule {}
```

- [ ] **Step 4: Implement `configureApp`**

Create `src/bootstrap.ts`. Every setting here previously lived in `main.ts`; the two additions are the global prefix with its health exclusion, versioning, and `enableImplicitConversion: false`.

```ts
import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AppConfig } from './config/configuration';

export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService<AppConfig, true>);

  app.use(helmet());
  app.enableCors({ origin: configService.get('cors.origin', { infer: true }) });

  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableShutdownHooks();
}
```

- [ ] **Step 5: Make the health controller version-neutral**

Excluding `/health` from the global prefix is not enough — `defaultVersion: '1'` would still place it at `/v1/health`. In `src/modules/health/health.controller.ts`, change the imports and the controller decorator:

```ts
import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
```

```ts
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
```

Leave the rest of the file unchanged.

- [ ] **Step 6: Slim down `main.ts`**

Replace the body of `src/main.ts` with the version below. It now owns only Swagger and `listen()`; everything else is shared with tests.

```ts
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureApp(app);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('E-commerce Backend API')
    .setDescription('API documentation for the e-commerce backend')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  const configService = app.get(ConfigService<AppConfig, true>);
  const port = configService.get('app.port', { infer: true });
  await app.listen(port);
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap application', error);
  process.exit(1);
});
```

- [ ] **Step 7: Create the test app helper**

Create `test/helpers/create-test-app.ts`. Using `configureApp` here is the whole point: tests exercise the same pipes, filters, prefix, and versioning as production.

```ts
import { INestApplication, ModuleMetadata } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';

export async function createTestApp(
  extraImports: NonNullable<ModuleMetadata['imports']> = [],
): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule, ...extraImports],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();

  return app;
}
```

- [ ] **Step 8: Run the routing tests to verify they pass**

```bash
npm run test:e2e -- routing
```

Expected: PASS, 9 tests.

- [ ] **Step 9: Update the existing health e2e test to use the helper**

Replace `test/app.e2e-spec.ts` with:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';

describe('HealthController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health (GET) reports ok when the database is reachable', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        const body = res.body as { status: string; timestamp: string };
        expect(body.status).toBe('ok');
        expect(typeof body.timestamp).toBe('string');
      });
  });
});
```

- [ ] **Step 10: Run the full verification**

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```

Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/bootstrap.ts src/main.ts src/modules/health/health.controller.ts \
        test/helpers/create-test-app.ts test/fixtures/ping.module.ts \
        test/routing.e2e-spec.ts test/app.e2e-spec.ts
git commit -m "feat: add shared app configuration with URI versioning under /api/v1"
```

---

## Task 3: Prisma error mapping in the exception filter

**Files:**
- Modify: `src/common/filters/http-exception.filter.ts`
- Test: `src/common/filters/http-exception.filter.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. `HttpExceptionFilter` behaviour changes — `P2002` → 409, `P2003` → 409, `P2025` → 404, unmapped Prisma codes → 500 with a generic message.

- [ ] **Step 1: Ensure the Prisma client is generated**

The filter imports the `Prisma` namespace, which only exists after generation.

```bash
npm run prisma:generate
```

Expected: `Generated Prisma Client (v6.19.3)`.

- [ ] **Step 2: Write the failing test**

Create `src/common/filters/http-exception.filter.spec.ts`:

```ts
import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from './http-exception.filter';

interface CapturedResponse {
  status: jest.Mock;
  json: jest.Mock;
}

function createHost(url = '/api/v1/widgets'): {
  host: ArgumentsHost;
  captured: CapturedResponse;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });

  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;

  return { host, captured: { status, json } };
}

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('database said no', {
    code,
    clientVersion: '6.19.3',
  });
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps P2002 unique violations to 409', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2002'), host);

    expect(captured.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(captured.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
      }),
    );
  });

  it('maps P2025 missing records to 404', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2025'), host);

    expect(captured.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('maps P2003 foreign key violations to 409', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2003'), host);

    expect(captured.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('never leaks the raw Prisma message to the client', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2002'), host);

    const body = captured.json.mock.calls[0][0] as { message: string };
    expect(body.message).not.toContain('database said no');
  });

  it('maps unrecognised Prisma codes to a generic 500', () => {
    const { host, captured } = createHost();

    filter.catch(prismaError('P2037'), host);

    expect(captured.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(captured.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Internal server error' }),
    );
  });

  it('still handles ordinary HttpExceptions', () => {
    const { host, captured } = createHost();

    filter.catch(new BadRequestException('bad input'), host);

    expect(captured.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
  });

  it('includes the request path and a timestamp', () => {
    const { host, captured } = createHost('/api/v1/orders');

    filter.catch(new BadRequestException('bad input'), host);

    expect(captured.json).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/v1/orders',
        timestamp: expect.any(String) as string,
      }),
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm test -- http-exception.filter
```

Expected: FAIL — the P2002 case reports 500 instead of 409.

- [ ] **Step 4: Implement the mapping**

In `src/common/filters/http-exception.filter.ts`, add the import:

```ts
import { Prisma } from '@prisma/client';
```

Add this constant just below the existing `SERVER_ERROR_THRESHOLD` declaration:

```ts
interface MappedPrismaError {
  statusCode: number;
  message: string;
  error: string;
}

const PRISMA_ERROR_MAP: Record<string, MappedPrismaError> = {
  P2002: {
    statusCode: HttpStatus.CONFLICT,
    message: 'A record with these values already exists',
    error: 'Conflict',
  },
  P2003: {
    statusCode: HttpStatus.CONFLICT,
    message: 'Related record constraint violated',
    error: 'Conflict',
  },
  P2025: {
    statusCode: HttpStatus.NOT_FOUND,
    message: 'The requested record was not found',
    error: 'Not Found',
  },
};
```

Then in `resolveException`, insert this block immediately **after** the `HttpException` branch and **before** the final generic `return`:

```ts
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_MAP[exception.code];

      if (mapped) {
        return mapped;
      }
    }
```

Unmapped codes deliberately fall through to the existing generic 500, so no Prisma internals ever reach a client.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test -- http-exception.filter
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Verify the whole suite**

```bash
npm run lint
npm run build
npm test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/common/filters/http-exception.filter.ts \
        src/common/filters/http-exception.filter.spec.ts
git commit -m "feat: map Prisma known request errors to HTTP status codes"
```

---

## Task 4: Pagination DTOs

**Files:**
- Create: `src/common/dto/pagination-query.dto.ts`
- Create: `src/common/dto/paginated.dto.ts`
- Test: `src/common/dto/pagination-query.dto.spec.ts`
- Test: `src/common/dto/paginated.dto.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `PaginationQueryDto` with `page: number` (default 1), `limit: number` (default 20), and a `skip` getter.
  - `PaginationMetaDto` with `page`, `limit`, `total`, `totalPages`.
  - `PaginatedDto<T>` with `data: T[]`, `meta: PaginationMetaDto`, and `PaginatedDto.from(data, total, query)`.

Phase 2 consumes these for `GET /api/v1/products`.

- [ ] **Step 1: Write the failing query DTO test**

Create `src/common/dto/pagination-query.dto.spec.ts`. Transformation is exercised with the exact options `configureApp` uses, so the test and the runtime cannot drift.

```ts
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PaginationQueryDto } from './pagination-query.dto';

function transform(query: Record<string, unknown>): PaginationQueryDto {
  return plainToInstance(PaginationQueryDto, query, {
    enableImplicitConversion: false,
  });
}

describe('PaginationQueryDto', () => {
  it('applies defaults when nothing is supplied', () => {
    const dto = transform({});

    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('converts numeric strings to numbers', () => {
    const dto = transform({ page: '3', limit: '50' });

    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
    expect(typeof dto.page).toBe('number');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects a non-numeric page', () => {
    expect(validateSync(transform({ page: 'abc' }))).not.toHaveLength(0);
  });

  it('rejects a page below 1', () => {
    expect(validateSync(transform({ page: '0' }))).not.toHaveLength(0);
  });

  it('rejects a limit above 100', () => {
    expect(validateSync(transform({ limit: '101' }))).not.toHaveLength(0);
  });

  it('rejects a fractional limit', () => {
    expect(validateSync(transform({ limit: '2.5' }))).not.toHaveLength(0);
  });

  it('computes skip from page and limit', () => {
    expect(transform({}).skip).toBe(0);
    expect(transform({ page: '3', limit: '20' }).skip).toBe(40);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- pagination-query
```

Expected: FAIL — `Cannot find module './pagination-query.dto'`.

- [ ] **Step 3: Implement `PaginationQueryDto`**

Create `src/common/dto/pagination-query.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1, description: '1-based page number' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test -- pagination-query
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing paginated DTO test**

Create `src/common/dto/paginated.dto.spec.ts`:

```ts
import { PaginatedDto } from './paginated.dto';
import { PaginationQueryDto } from './pagination-query.dto';

describe('PaginatedDto', () => {
  const query = Object.assign(new PaginationQueryDto(), { page: 2, limit: 20 });

  it('wraps data with pagination metadata', () => {
    const result = PaginatedDto.from([{ id: 'a' }], 137, query);

    expect(result.data).toEqual([{ id: 'a' }]);
    expect(result.meta).toEqual({
      page: 2,
      limit: 20,
      total: 137,
      totalPages: 7,
    });
  });

  it('rounds partial pages up', () => {
    const result = PaginatedDto.from([], 21, query);

    expect(result.meta.totalPages).toBe(2);
  });

  it('reports zero pages for an empty result set', () => {
    const result = PaginatedDto.from([], 0, query);

    expect(result.meta.totalPages).toBe(0);
    expect(result.data).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
npm test -- paginated.dto
```

Expected: FAIL — `Cannot find module './paginated.dto'`.

- [ ] **Step 7: Implement `PaginatedDto`**

Create `src/common/dto/paginated.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';

export class PaginationMetaDto {
  @ApiProperty({ example: 2 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 137 })
  total!: number;

  @ApiProperty({ example: 7 })
  totalPages!: number;
}

export class PaginatedDto<T> {
  data!: T[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;

  static from<T>(
    data: T[],
    total: number,
    query: { page: number; limit: number },
  ): PaginatedDto<T> {
    const result = new PaginatedDto<T>();

    result.data = data;
    result.meta = {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };

    return result;
  }
}
```

- [ ] **Step 8: Run it to verify it passes**

```bash
npm test -- paginated.dto
```

Expected: PASS, 3 tests.

- [ ] **Step 9: Verify the whole suite**

```bash
npm run lint
npm run build
npm test
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/common/dto/
git commit -m "feat: add shared pagination query and response DTOs"
```

---

## Task 5: Swagger helper for paginated responses

Swagger cannot infer `PaginatedDto<T>` because TypeScript generics are erased at runtime. Without this decorator, every list endpoint documents `data` as an untyped array.

**Files:**
- Create: `src/common/swagger/api-paginated-response.decorator.ts`
- Test: `src/common/swagger/api-paginated-response.decorator.spec.ts`

**Interfaces:**
- Consumes: `PaginatedDto`, `PaginationMetaDto` (Task 4).
- Produces: `ApiPaginatedResponse(model): MethodDecorator & ClassDecorator`.

- [ ] **Step 1: Write the failing test**

Create `src/common/swagger/api-paginated-response.decorator.spec.ts`. It builds a real OpenAPI document from a fixture controller and inspects the emitted schema.

```ts
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiProperty, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiPaginatedResponse } from './api-paginated-response.decorator';
import { PaginatedDto } from '../dto/paginated.dto';

class WidgetDto {
  @ApiProperty()
  id!: string;
}

@Controller('widgets')
class WidgetsController {
  @Get()
  @ApiPaginatedResponse(WidgetDto)
  findAll(): PaginatedDto<WidgetDto> {
    return PaginatedDto.from<WidgetDto>([], 0, { page: 1, limit: 20 });
  }
}

describe('ApiPaginatedResponse', () => {
  it('documents data as an array of the given model', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WidgetsController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').setVersion('1').build(),
    );

    const widgetsPath = JSON.stringify(document.paths['/widgets']);

    expect(widgetsPath).toContain('#/components/schemas/PaginatedDto');
    expect(widgetsPath).toContain('#/components/schemas/WidgetDto');
    expect(widgetsPath).toContain('#/components/schemas/PaginationMetaDto');
    expect(document.components?.schemas?.WidgetDto).toBeDefined();

    await app.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -- api-paginated-response
```

Expected: FAIL — `Cannot find module './api-paginated-response.decorator'`.

- [ ] **Step 3: Implement the decorator**

Create `src/common/swagger/api-paginated-response.decorator.ts`. `ApiExtraModels` is required because these types are never referenced directly in a route signature, so Swagger would otherwise omit them from `components.schemas`.

```ts
import { applyDecorators, Type as NestType } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { PaginatedDto, PaginationMetaDto } from '../dto/paginated.dto';

export function ApiPaginatedResponse<TModel extends NestType<unknown>>(
  model: TModel,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(PaginatedDto, PaginationMetaDto, model),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(PaginatedDto) },
          {
            properties: {
              data: {
                type: 'array',
                items: { $ref: getSchemaPath(model) },
              },
              meta: { $ref: getSchemaPath(PaginationMetaDto) },
            },
          },
        ],
      },
    }),
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test -- api-paginated-response
```

Expected: PASS, 1 test.

- [ ] **Step 5: Verify the whole suite**

```bash
npm run lint
npm run build
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/common/swagger/
git commit -m "feat: add ApiPaginatedResponse swagger decorator"
```

---

## Task 6: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: the e2e harness (Task 1) — CI supplies `TEST_DATABASE_URL` pointing at its service container.
- Produces: a `lint:ci` npm script.

- [ ] **Step 1: Add a non-mutating lint script**

The existing `lint` script passes `--fix`, which silently rewrites files — wrong for CI, where lint must report rather than repair. In `package.json`, add alongside it:

```json
    "lint:ci": "eslint \"{src,apps,libs,test}/**/*.ts\" --max-warnings 0",
```

- [ ] **Step 2: Verify the new script locally**

```bash
npm run lint:ci
```

Expected: exits 0 with no output.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/ci.yml`. The service container maps to host port 5433 so the same `TEST_DATABASE_URL` works locally and in CI.

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: ecommerce_test
        ports:
          - 5433:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5433/ecommerce_test
      TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5433/ecommerce_test

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Generate Prisma client
        run: npx prisma generate

      - name: Lint
        run: npm run lint:ci

      - name: Build
        run: npm run build

      - name: Unit tests
        run: npm test

      - name: E2E tests
        run: npm run test:e2e
```

- [ ] **Step 4: Verify the workflow file parses**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/ci.yml','utf8');if(!s.includes('TEST_DATABASE_URL'))throw new Error('missing env');console.log('workflow file present, length',s.length)"
```

Expected: prints the file length. (Full YAML validation happens on push.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json
git commit -m "ci: add GitHub Actions pipeline with postgres service container"
```

---

## Task 7: Documentation and conventions

Records the Phase F decisions where future work will actually read them.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by code.

- [ ] **Step 1: Update the API conventions in `CLAUDE.md`**

In the `## API Conventions` section, replace the line:

```
- API versioning/prefix strategy is intentionally undecided — settle it when the first real domain module (likely `auth`) lands, not before.
```

with:

```
- Global prefix `api` + URI versioning, default version `1` — all domain routes live under `/api/v1/*`.
- `/health` is excluded from both the prefix and versioning (`VERSION_NEUTRAL`) so infrastructure probes have a stable path.
- Single resources are returned bare; collections are wrapped as `{ data, meta }` using `PaginatedDto` from `src/common/dto/`.
- Controllers never return Prisma model objects directly — each module defines response DTOs with a static `from()` mapper. `@Exclude()` silently does nothing on Prisma's plain objects, so explicit mapping is the only thing that actually prevents field leaks.
- List endpoints accept `PaginationQueryDto` and document their response with `@ApiPaginatedResponse(Model)`.
```

- [ ] **Step 2: Add the app-configuration rule to `CLAUDE.md`**

In the `## Architecture Principles` section, append:

```
- All application-level configuration (helmet, CORS, prefix, versioning, pipes, filters, shutdown hooks) lives in `configureApp()` in `src/bootstrap.ts`, so runtime and e2e tests are configured identically. `main.ts` owns only Swagger and `listen()`.
```

- [ ] **Step 3: Update the testing requirements in `CLAUDE.md`**

In `## Testing Requirements`, append:

```
- E2E tests run against a dedicated Postgres on port 5433 (`docker compose up -d postgres-test`), addressed by `TEST_DATABASE_URL`. `test/setup-e2e.ts` redirects `DATABASE_URL` per worker; `test/global-setup.ts` applies migrations once per run.
- Use `createTestApp()` from `test/helpers/create-test-app.ts` so tests exercise the real pipes, filters, prefix, and versioning.
- Reset state between tests with `truncateAll()` from `test/helpers/truncate.ts`.
- `test/` is the one place outside `src/config/` allowed to read `process.env` directly — it must configure the environment before the app boots.
```

- [ ] **Step 4: Update the data conventions in `CLAUDE.md`**

In `## Database Conventions`, append:

```
- Primary keys are UUID v7 strings (`@default(uuid(7))`).
- Money is stored as integer minor units (`priceCents Int`) plus a `currency` field. Floating-point money is banned.
- Every model carries `createdAt` and `updatedAt`.
- Models are PascalCase singular with camelCase fields; `@@map`/`@map` render snake_case plural tables.
```

- [ ] **Step 5: Update `README.md`**

In the setup section, change step 3 to start both databases:

```
# 3. Start PostgreSQL (dev on 5432, test on 5433)
docker compose up -d
```

Replace the Project Status checklist's first line and add the foundation entry:

```
- ✅ Project structure, config validation, Prisma wiring, health check, Swagger, Docker (Postgres)
- ✅ Foundation: `/api/v1` versioning, pagination primitives, Prisma error mapping, e2e harness, CI
```

Add to the scripts table:

```
| `npm run lint:ci`        | Lint without auto-fixing (used by CI)|
```

In the Project Structure block, add these lines under `src/`:

```
  bootstrap.ts        # configureApp() — shared runtime/test configuration
```

and under the `test/` entry:

```
test/
  helpers/             # createTestApp, truncateAll
  fixtures/            # controllers used only by tests
```

- [ ] **Step 6: Final full verification**

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```

Expected: all four pass.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: record Phase F conventions in CLAUDE.md and README"
```

---

## Definition of Done

Checked against spec §9:

| Spec requirement | Task |
|---|---|
| 1. URI versioning; `/api/v1/*`; `/health` unprefixed | 2 |
| 2. Pagination DTOs + `@ApiPaginatedResponse()` with unit tests | 4, 5 |
| 3. Filter maps `P2002`, `P2025`, `P2003` with unit tests | 3 |
| 4. `ValidationPipe` sets `enableImplicitConversion: false` | 2 |
| 5. Test Postgres on 5433; `TEST_DATABASE_URL` in `.env.example` + Joi | 1 |
| 6. Jest global setup; `truncateAll()`; `createTestApp()` | 1, 2 |
| 7. GitHub Actions: lint → build → unit → e2e | 6 |
| 8. `CLAUDE.md` updated, deferred-versioning note replaced | 7 |

**Deliberately deferred to Phase 1:** `test/factories/` (no models exist yet to build fixtures for), the global `JwtAuthGuard` and its is-it-really-global regression test, and `@nestjs/throttler`.
