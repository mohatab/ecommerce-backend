# CLAUDE.md

Guidance for working on this repository. This project is built **phase by phase** — read this before making any change.

## Project Purpose

A production-grade e-commerce backend, built as a portfolio project for a backend developer job search. The goal is to demonstrate clean architecture, security awareness, and test discipline — not feature breadth. Depth and correctness over speed.

## Tech Stack

- Node.js 20 + TypeScript (strict mode)
- NestJS
- PostgreSQL + Prisma ORM
- Redis + BullMQ (caching / background jobs — not yet introduced)
- JWT (auth — not yet introduced)
- Docker / docker-compose
- Jest (unit + e2e)
- Swagger (OpenAPI docs served at `/api/docs`)

## Architecture Principles

- Modular, domain-oriented structure under `src/modules/*`; each module owns its controllers, services, and DTOs.
- `src/common/` is for cross-cutting concerns only (filters, interceptors, guards, pipes) — never domain/business logic.
- `src/config/` is the single place that reads `process.env`. Nothing else should call `process.env` directly.
- `src/prisma/` is the only database access layer. `PrismaService` is the only place `PrismaClient` is instantiated.
- Fail fast: invalid/missing env vars abort boot (via Joi validation), errors are never swallowed silently.
- Nothing is implemented ahead of its phase (see Important Constraints).

## Module Boundaries

- Feature modules live at `src/modules/<domain>/` (currently: `health`; future: `auth`, `products`, `orders`, `payments`, ...).
- A module may depend on: its own files, `src/common`, `src/config`, `src/prisma` (via `PrismaService`), and other modules' explicitly exported providers through NestJS module imports — never by reaching into another module's internal files directly.
- Controllers stay thin: validate input via DTO, delegate to a service, shape the response. Business logic belongs in services.

## Coding Conventions

- Strict TypeScript (`strict: true`) everywhere. Avoid `any`; if unavoidable, comment why.
- ESLint + Prettier are enforced — `npm run lint` must be clean before a change is considered done.
- Request input is validated with `class-validator` DTOs — never trust a raw request body.
- Public methods have explicit return types.
- No unused locals/parameters (enforced by `tsconfig.json`).

## Security Requirements

- Never hardcode secrets or credentials. All configuration comes from environment variables, validated in `src/config/env.validation.ts`.
- `.env` is gitignored and never committed. `.env.example` must stay in sync with every env var actually read by the app.
- `helmet()` and config-driven CORS in `main.ts` are mandatory — don't remove or bypass them.
- Every mutating endpoint requires a validated DTO; the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) must stay enabled.
- Once auth exists: passwords are hashed, tokens are signed with a secret from env, and neither is ever logged.
- Client-facing errors never leak internals (stack traces, SQL, raw exception messages) — always go through `HttpExceptionFilter`.

## Testing Requirements

- Every service containing business logic gets unit tests (mock `PrismaService` and other dependencies).
- Critical flows (auth, orders, payments once they exist) require e2e coverage in `test/`.
- New endpoints get at least one e2e test against a real (dockerized) Postgres instance.
- `npm test` and `npm run test:e2e` must pass before a feature is considered complete.

## Database Conventions

- All schema changes go through `prisma/schema.prisma` + `prisma migrate dev`. Never hand-edit the database.
- A model is added only in the phase that owns it (e.g. the `Product` model arrives with the products module, not before).
- The database is accessed only through `PrismaService` — no ad hoc `pg` clients or raw connections elsewhere.
- Migrations are committed to git and never edited retroactively once applied/merged.

## API Conventions

- Every endpoint is documented with Swagger decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse`).
- REST, resource-based routes with plural nouns (`/health`, `/products`, `/orders`, ...).
- Consistent error response shape from `HttpExceptionFilter`: `{ statusCode, message, error, timestamp, path }`.
- API versioning/prefix strategy is intentionally undecided — settle it when the first real domain module (likely `auth`) lands, not before.

## Git Conventions

- Clear, descriptive commit messages; never commit `.env`, secrets, or generated output (`dist/`, `coverage/`, `node_modules/`).
- Only commit when explicitly asked to — do not commit proactively.
- Keep commits scoped to the phase/task being worked on.

## Important Constraints

- Build phase by phase. Do not implement the whole project, or a future phase's domain (auth, products, orders, payments, Redis/BullMQ), ahead of being asked.
- Do not add dependencies beyond what the current phase actually needs.
- Do not modify files unrelated to the current task/phase.
- Explain architectural decisions before implementing them — get alignment first, especially for anything affecting shared structure (config, common, prisma).

## Rules to Follow When Modifying This Project

1. Confirm which phase a change belongs to before writing code for it. If unclear, ask rather than assume.
2. Never hardcode a secret; if a new env var is needed, add it to both `.env.example` and the Joi schema in `src/config/env.validation.ts`.
3. Before calling a change done: `npm run lint`, `npm run build`, `npm test` must pass; run `npm run test:e2e` too when the change touches anything DB-dependent.
4. Do not loosen `tsconfig.json` strictness or disable an ESLint rule to make an error go away — fix the underlying issue.
5. Stay inside the current task's module/domain — don't touch unrelated modules "while you're in there."
6. Update this file when architecture, conventions, or constraints actually change.
