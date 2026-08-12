# E-commerce Backend

[![CI](https://github.com/mohatab/ecommerce-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/mohatab/ecommerce-backend/actions/workflows/ci.yml)

A production-grade e-commerce backend, built as a portfolio project to demonstrate clean, maintainable backend architecture.

## Tech Stack

- **Node.js** / **TypeScript** (strict mode)
- **NestJS** — application framework
- **PostgreSQL** + **Prisma ORM** — persistence
- **Redis** + **BullMQ** — caching and background jobs *(added in a later phase)*
- **JWT** — authentication *(added in a later phase)*
- **Docker** — containerization
- **Jest** — testing
- **Swagger** — API documentation

## Project Status

This project is being built incrementally, phase by phase. Current phase: **project initialization**.

- ✅ Project structure, config validation, Prisma wiring, health check, Swagger, Docker (Postgres)
- ✅ Foundation: `/api/v1` versioning, pagination primitives, Prisma error mapping, e2e harness, CI
- ⬜ Authentication (JWT)
- ⬜ Products
- ⬜ Orders
- ⬜ Payments
- ⬜ Redis caching & BullMQ background jobs

## Getting Started

### Prerequisites

- Node.js 20+
- Docker

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment variables
cp .env.example .env

# 3. Start PostgreSQL (dev on 5432, test on 5433)
docker compose up -d

# 4. Generate the Prisma client
npm run prisma:generate

# 5. Run the app in watch mode
npm run start:dev
```

The API will be available at `http://localhost:3000`, with Swagger docs at `http://localhost:3000/api/docs`.

### Useful Scripts

| Script                  | Description                          |
| ------------------------ | ------------------------------------ |
| `npm run start:dev`      | Run the app in watch mode            |
| `npm run build`          | Compile the app                      |
| `npm run lint`           | Lint and auto-fix                    |
| `npm run lint:ci`        | Lint without auto-fixing (used by CI)|
| `npm test`               | Run unit tests                       |
| `npm run test:e2e`       | Run end-to-end tests                 |
| `npm run prisma:generate`| Regenerate the Prisma client         |
| `npm run prisma:migrate` | Create/apply a local dev migration   |

## Project Structure

```
src/
  main.ts            # application bootstrap (Swagger, listen)
  bootstrap.ts        # configureApp() — shared runtime/test configuration
  app.module.ts       # composition root
  config/             # environment validation + typed configuration
  common/             # cross-cutting concerns (filters, interceptors, etc.)
  prisma/             # PrismaService, injectable database client
  modules/            # feature modules (health, and future domains: auth, products, orders...)
prisma/
  schema.prisma        # Prisma schema (datasource + generator)
test/                  # e2e tests
  helpers/             # createTestApp, truncateAll
  fixtures/            # controllers used only by tests
```
