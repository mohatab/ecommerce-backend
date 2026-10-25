# Phase 6 Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped Docker artifact verified rather than merely built — it starts, migrates, serves, reports healthy, and stops cleanly, proven in CI — and settle the trusted-proxy decision the repository explicitly deferred to this phase.

**Architecture:** Seven sequential-where-they-share-files tasks. Three application changes (a liveness endpoint, a trusted-proxy setting, three production config guards), two artifact changes (a migration stage and a verified `HEALTHCHECK`, plus compose services), one CI job that runs the real image and asserts eleven controls against it, and a documentation closeout that reports measured numbers. No new runtime dependency, no migration, no new route beyond `/health/live`.

**Tech Stack:** NestJS 11 · TypeScript strict · Prisma 6 · PostgreSQL 16 · Joi 18 · `@nestjs/throttler` 6.5.0 · Docker multi-stage (`node:20-alpine`) · GitHub Actions · Jest 30 (unit + e2e)

**Spec:** `docs/superpowers/specs/2026-10-09-phase-6-deployment-design.md` — the authority for this phase. Read it alongside this plan. Where plan and spec disagree, the spec wins; report the disagreement rather than resolving it silently.

---

## Git prerequisite — read before Task 1

**The working tree is NOT on `master`.** Verified at plan time:

| | |
|---|---|
| Current branch | `phase-5/scheduled-maintenance` |
| `HEAD` | `e927ef92f480f4cb7d0786068c396f2660583e08` |
| `master` = `origin/master` | `ba59a2a0e69e9bbf593e244a6f302d90446dc6d2` |
| Is `HEAD` an ancestor of `master`? | **yes** |
| Is `HEAD`'s tree identical to `master`'s? | **yes** |

So the file contents are master's, but the branch pointer is not. **Create the Phase 6 branch from `master`, never from `HEAD`:**

```bash
git fetch origin
git switch -c phase-6/deployment master
git rev-parse --abbrev-ref HEAD   # expect: phase-6/deployment
git rev-parse HEAD                 # expect: ba59a2a0e69e9bbf593e244a6f302d90446dc6d2
```

Branching from `HEAD` would produce a branch whose merge-base is a Phase 5 commit rather than the merge commit — the history would be correct by content and wrong by shape.

Two untracked files exist and **both must be left alone**:

- `bash.exe.stackdump` — do not read, modify, delete, commit, or add to `.gitignore`. It is not a defect of this project.
- `docs/superpowers/specs/2026-10-09-phase-6-deployment-design.md` — the spec. Commit it as the first commit on the Phase 6 branch (Task 1, Step 1), together with this plan.

Also retained and **not to be deleted**: the Phase 5 SDD workspace at `.superpowers/sdd/2026-10-07-phase-5-scheduled-maintenance/`.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Zero migrations.** `prisma/migrations/` must be byte-identical at the end of the phase. Phase 6 adds no model, no column, no index. (DoD 22)
- **Zero new runtime dependencies.** `package.json`'s `dependencies` block must be unchanged. `devDependencies` must also be unchanged — nothing in this phase needs a new tool. (DoD 23)
- **No new route beyond `/health/live`.** (DoD 24)
- **No Redis, no BullMQ, no message broker.** (Spec D2, §14.4)
- **No registry publish, no image push, no registry login.** (Spec D10)
- **No Kubernetes, no Helm, no cloud provider service, no real-host deployment.** (Spec §2.2)
- **No structured logging subsystem, no correlation ids, no metrics, no tracing.** The only observability content of this phase is `ENV TZ=UTC` and one boot topology log line. (Spec D9, §16)
- **No change to Phase 5 maintenance jobs or lease logic.** No sweep, no job, no `MaintenanceLeaseService` method, no `assertHeld` call site may change. (Spec §2.3)
- **No change to Phase 4's payment authority.** `OrdersService.markPaid()` stays the only writer of `OrderStatus.PAID` in `src/`, and `PaymentWebhookService` its only caller. (Spec §2.3, DoD 24)
- **No `buildx`, no Bake, no new build tooling** to make one command produce two tags. Two plain `docker build --target` invocations. (Spec §9.1)
- **No least-privilege database role work.** Explicitly out of scope. (Spec §2.2, §19.3 item 8)
- **Do not loosen `tsconfig.json` strictness or disable an ESLint rule.** Fix the underlying issue.
- **`npm run lint:ci`, never `npm run lint`,** is the gate. `lint`'s `--fix` repairs a violation before anyone sees it.
- **Locked decisions D1–D10 may not be reopened.** A decision changes only by amending spec §3 with the repository evidence that forced it. If you believe one must change, **stop and report** rather than changing it.
- **Never log** a password, digest, token, the webhook secret, the API key, the signature header, the raw payload, or `DATABASE_URL`.
- **History hygiene:** do not amend, rebase, squash, force-push, or rewrite history. Commit only when a step says to.

### Commit message attribution

Every commit in this phase ends with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

## Review Focus

Five input classes the spec implies but which no task's assertions would naturally exercise. Each has its test assigned to the task owning the code, in that task's own step style. Most likely to bite first.

1. **`TRUST_PROXY_HOPS` set *higher* than the real proxy chain depth → silent, total throttle bypass.** The spec names too-high as the dangerous direction (§5.3) but defines no control for it. A reader will assume "more trust is more secure". Test owned by **T2, Step 14** — asserts that with `hops=2` behind one proxy the bucket keys on an **attacker-supplied** value, so the hazard is demonstrated rather than described.
2. **`TRUST_PROXY_HOPS` malformed — `'abc'`, `'-1'`, `'1.5'`, `''`.** Joi says integer ≥ 0; a float or a negative must be rejected at boot, not coerced. Express's `trust proxy` accepts a number *or a string*, and a silently-passed `'abc'` becomes a hostname matcher that trusts nothing while looking configured. Test owned by **T2, Step 4**.
3. **`/health/live` must be excluded from the global prefix, and the existing exclude list names only `health`.** `src/bootstrap.ts:43` is `exclude: [{ path: 'health', method: RequestMethod.GET }]`. A `@Get('live')` handler produces the route path `health/live`, which does **not** match that entry, so `/health/live` would be served at `/api/health/live` and DoD 1's "unprefixed and unversioned" would be false while every other health assertion still passed. Test owned by **T1, Step 6**.
4. **The boot topology log must leak no secret.** `DATABASE_URL` embeds a password, and it is the single most tempting value to include in a "what am I configured as" line. Test owned by **T3, Step 13**.
5. **`.dockerignore` tightening must not break the build.** Adding `test/` and `docs/` changes what `COPY . .` delivers to the build stage. `tsconfig.build.json` excludes `test` and `**/*spec.ts` so `nest build` is safe, and `prisma/` is not excluded so `npx prisma generate` is safe — but both are assumptions until the image builds. Test owned by **T4, Step 11**.

---

## File structure

Every file this phase touches. Nothing outside this list may change.

### Created

| File | Responsibility |
|---|---|
| `test/trust-proxy.e2e-spec.ts` | C-D1, C-D2, and Review Focus 1 — the trusted-proxy reference-topology controls |
| `.github/workflows/` *(no new file)* | — the smoke job extends the existing `docker` job in `ci.yml` |

### Modified

| File | Change | Task |
|---|---|---|
| `src/modules/health/health.controller.ts` | add `live()` handler + `LivenessStatus` interface | T1 |
| `src/modules/health/health.controller.spec.ts` | unit tests for `live()`, incl. database-down | T1 |
| `src/bootstrap.ts:43` | add `health/live` to the global-prefix exclude list | T1 |
| `src/bootstrap.ts` (`configureApp`) | add `app.set('trust proxy', hops)` | T2 |
| `src/config/env.validation.ts:19-105` | add `TRUST_PROXY_HOPS`; make `CORS_ORIGIN` production-strict | T2, T3 |
| `src/config/configuration.ts` | add `app.trustProxyHops` to `AppConfig` + factory | T2 |
| `src/config/env.validation.spec.ts` | add `validProdEnv()`; new guard tests; **fix the one test that breaks** | T2, T3 |
| `src/config/configuration.spec.ts` | assert the new config key | T2 |
| `src/main.ts:13-20` | gate Swagger on `NODE_ENV`; add the boot topology log | T3 |
| `.env.example` | add `TRUST_PROXY_HOPS=0` with its comment | T2 |
| `Dockerfile` | `migrate` stage **before** `runtime`; `HEALTHCHECK`; `ENV TZ=UTC` | T3, T4 |
| `Dockerfile` (runtime stage `RUN`) | chain the Prisma migration-tooling prune into `npm ci --omit=dev` | T4a |
| `.dockerignore` | add `docs`, `test`, `.superpowers`, `.claude` | T4 |
| `docker-compose.yml` | add `app` and `migrate` services | T5 |
| `.github/workflows/ci.yml:96-107` | extend `docker` job to build → migrate → run → verify → stop | T6 |
| `test/app.e2e-spec.ts` | `/health/live` serves 200 | T1 |
| `test/routing.e2e-spec.ts` | `/health/live` unprefixed; `/api/v1/health/live` 404s | T1 |
| `test/auth-throttle.e2e-spec.ts` | `/health/live` survives past the throttle limit (C-D4) | T1 |
| `README.md` | status line, env table, release runbook | T7 |
| `docs/deferred-limitations.md` | close 2 entries, sharpen 1, add 5 | T7 |
| `CLAUDE.md` | Phase 6 section | T7 |

### Explicitly NOT modified

`prisma/schema.prisma` · `prisma/migrations/**` · `package.json` · `package-lock.json` · any `src/modules/maintenance/**` file · any `src/modules/payments/**` file · `src/app.module.ts` · `test/helpers/truncate.ts` · `test/helpers/reset-leases.ts` · `test/jest-e2e.json` · `bash.exe.stackdump`

---

## Task dependency order

```
T1 ──▶ T2 ──▶ T3 ──┐
                   ├──▶ T6 ──▶ T7
T4 ──▶ T4a ──▶ T5 ─┘
```

**Strictly sequential: T1 → T2 → T3.** The spec (§18) calls T1, T2, and T4 mutually independent. **That is true of T4 and false of T1 and T2**, and the plan corrects it: T1 must edit `src/bootstrap.ts:43` (the prefix exclude list — Review Focus 3) and T2 edits `configureApp()` in the same file. T2 and T3 additionally share `env.validation.ts`, `configuration.ts`, `.env.example`, and `env.validation.spec.ts`. Running any of these three concurrently guarantees a conflict in the files where a merge error is a security bug. See "Contradictions found" at the end.

**T4 is genuinely independent** and may run before, during, or after T1–T3. **T4a depends on T4** and edits the same file (the runtime stage's `RUN` line), so the two are never concurrent. **T5 depends on T4a**, because the image it composes must be the pruned one. **T6 requires T1, T2, T3, T4 and T4a to have passed their gates** — its container controls run against the pruned runtime image. **T7 is last and reports measured numbers only.**

---

## Local verification gates

Every task ends with these. A task is not complete until all of them pass and the actual output has been read — not assumed.

```bash
npm run lint:ci     # must be clean; --max-warnings 0, no autofix
npm run build       # must be clean
npm test            # unit; baseline 33 suites / 430 tests
npm run test:e2e    # required for T1, T2, T3 (app wiring / DB dependent)
```

**Before any `npm run test:e2e`:** `docker compose up -d postgres-test` must be running, and no other e2e run may hold the test database (`test/helpers/e2e-lock.ts` takes a session-scoped advisory lock and throws if one is held — that refusal means another run is active, not a bug).

**Baseline to compare against**, from the Phase 5 closeout at this exact tree: unit **33 suites / 430 tests**, e2e **28 suites / 337 tests**, OpenAPI inventory **21/21**. These are the numbers to beat, not to reprint — T7 reports what is measured at the end.

---

## Task 1: `/health/live` and probe semantics

**Objective:** add a liveness endpoint that performs **zero I/O**, is **not rate-limited**, and is **unprefixed and unversioned** — while leaving `/health` byte-for-byte unchanged in behaviour. Closes G4.

**Files:**
- Modify: `src/modules/health/health.controller.ts` (add handler; `interface HealthStatus` is at :12, class at :20, `check()` at :32)
- Modify: `src/modules/health/health.controller.spec.ts` (37 lines today)
- Modify: `src/bootstrap.ts:43` — the global-prefix exclude list
- Modify: `test/app.e2e-spec.ts` (27 lines today)
- Modify: `test/routing.e2e-spec.ts` (health block at :19-25)
- Modify: `test/auth-throttle.e2e-spec.ts` (C-D4)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /health/live` → `200 { status: 'ok' }`. T4's `HEALTHCHECK` targets this exact path. T6 polls it. No TypeScript symbol is exported for later tasks.

**Dependencies:** none. **Must complete before T2** (shared file: `src/bootstrap.ts`).

**Spec sections:** §6 (all), §6.5, §10.3, §17.2, §17.3 (C-D3, C-D4). **DoD:** 1, 2, 3, 8 (unit half), 24.

---

- [ ] **Step 1: Create the branch and commit the spec + plan**

```bash
git fetch origin
git switch -c phase-6/deployment master
git rev-parse HEAD   # must print ba59a2a0e69e9bbf593e244a6f302d90446dc6d2
git add docs/superpowers/specs/2026-10-09-phase-6-deployment-design.md docs/superpowers/plans/2026-10-09-phase-6-deployment.md
git commit -m "$(cat <<'EOF'
docs: add phase 6 deployment spec and plan

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Do **not** `git add -A` — `bash.exe.stackdump` is untracked and must stay that way.

- [ ] **Step 2: Write the failing unit tests for `live()`**

Append to `src/modules/health/health.controller.spec.ts`, inside the existing top-level `describe('HealthController')` block. The existing `prisma` mock (`{ $queryRaw: jest.fn() }`, declared at :8 and built at :11) is reused as-is.

```ts
  describe('live', () => {
    it('returns ok without touching the database', () => {
      const result = controller.live();

      expect(result).toEqual({ status: 'ok' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    // C-D3, unit half. The container half lives in T6.
    //
    // This is the assertion that NAMES the property: liveness must not depend
    // on the database. Asserting live() returns 200 while the database is UP
    // proves nothing, because every endpoint returns 200 then.
    it('still returns ok when the database is unreachable', () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      expect(controller.live()).toEqual({ status: 'ok' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('is synchronous, so it cannot await I/O', () => {
      expect(controller.live()).not.toBeInstanceOf(Promise);
    });
  });
```

- [ ] **Step 3: Run the unit tests to verify they fail**

Run: `npx jest src/modules/health --verbose`
Expected: FAIL — `controller.live is not a function`.

- [ ] **Step 4: Implement `live()`**

In `src/modules/health/health.controller.ts`, add the interface next to the existing `HealthStatus` (at :12) and the handler **above** `check()`:

```ts
interface LivenessStatus {
  status: 'ok';
}
```

```ts
  /**
   * Liveness: is this process up and able to answer at all.
   *
   * Deliberately does NO I/O — no database, no provider, no file system — and
   * is deliberately SYNCHRONOUS so it cannot grow an `await` by accident.
   *
   * It must never consult the database, and that is not a style preference.
   * `PrismaService.onModuleInit()` calls `$connect()`, and a failure there
   * propagates to `main.ts`'s `bootstrap().catch` -> `process.exit(1)`. So a
   * liveness probe pointed at the database-touching `/health` turns a
   * transient database blip into an UNBOOTABLE CRASH LOOP: the restart cannot
   * succeed while the database is down, where the running container would
   * have reconnected on its own through Prisma's pool. The restart actively
   * prevents the recovery that would otherwise have happened.
   *
   * There is no 503 branch, because there is nothing to check. If the process
   * cannot answer, the absence of a response IS the signal.
   *
   * @SkipThrottle is also load-bearing, and the asymmetry with `check()` is
   * deliberate: `/health` costs a database round trip and stays throttled, or
   * an unauthenticated caller gets a database-load amplifier. This one costs
   * nothing, so skipping is free. Do not "simplify" by skipping both.
   */
  @Get('live')
  @SkipThrottle()
  @ApiOperation({ summary: 'Liveness probe — process only, no dependencies' })
  @ApiResponse({ status: 200, description: 'The process is serving' })
  live(): LivenessStatus {
    return { status: 'ok' };
  }
```

Add `SkipThrottle` to the imports:

```ts
import { SkipThrottle } from '@nestjs/throttler';
```

`SkipThrottle` is exported by the already-installed `@nestjs/throttler@6.5.0` — verified. This adds **no dependency**.

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx jest src/modules/health --verbose`
Expected: PASS, 5 tests (2 pre-existing + 3 new).

- [ ] **Step 6: Write the failing routing e2e tests — Review Focus 3**

Add to the health block in `test/routing.e2e-spec.ts`, after the existing `/health` tests at :19-25:

```ts
    it('serves /health/live unprefixed and unversioned', async () => {
      await request(app.getHttpServer())
        .get('/health/live')
        .expect(200)
        .expect({ status: 'ok' });
    });

    // Review Focus 3. The global-prefix exclude list in src/bootstrap.ts named
    // only `health`, and a @Get('live') handler produces the ROUTE PATH
    // `health/live`, which does not match that entry. Without a second
    // exclude entry this endpoint is served at /api/health/live instead, and
    // every other liveness assertion in this phase still passes while DoD
    // item 1's "unprefixed and unversioned" is quietly false.
    it('does not serve health/live under the versioned prefix', async () => {
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(404);
    });

    it('does not serve health/live under the bare prefix', async () => {
      await request(app.getHttpServer()).get('/api/health/live').expect(404);
    });
```

- [ ] **Step 7: Run them to verify they fail for the right reason**

Run: `npm run test:e2e -- routing`
Expected: FAIL. The first test 404s (the route is prefixed), and `does not serve health/live under the bare prefix` returns 200 instead of 404. **Read the output and confirm that is the failure** — if the first test passes, the exclude list already covers it and Review Focus 3 was wrong; report that rather than deleting the test.

- [ ] **Step 8: Add the exclude entry**

`src/bootstrap.ts:43` — replace:

```ts
    exclude: [{ path: 'health', method: RequestMethod.GET }],
```

with:

```ts
    // Two entries, not one. A route is matched by its FULL path, so `health`
    // does not cover `health/live`: without the second entry the liveness
    // probe is served at /api/health/live while /health stays unprefixed —
    // and every liveness test that only checks for a 200 still passes.
    // Infrastructure probes need stable, unprefixed, unversioned paths.
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/live', method: RequestMethod.GET },
    ],
```

- [ ] **Step 9: Run the routing e2e to verify it passes**

Run: `npm run test:e2e -- routing`
Expected: PASS, including the two pre-existing `/health` tests — they must not regress.

- [ ] **Step 10: Add the liveness e2e to `test/app.e2e-spec.ts`**

```ts
  it('/health/live (GET) reports ok', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });
```

- [ ] **Step 11: Write the failing C-D4 test — the probe is not rate-limited**

Add to `test/auth-throttle.e2e-spec.ts`. The suite deliberately uses the real production limits (it calls `createTestApp()` with no `throttleLimit`), which is exactly what this control needs.

```ts
  // C-D4. The global limit is 100/60s per route handler per IP; /health/live
  // must survive past it because it is an infrastructure probe, not a client.
  //
  // 105 requests: more than the global cap of 100, so an un-skipped handler
  // 429s before the loop ends.
  it('does not rate-limit /health/live past the global limit', async () => {
    for (let i = 0; i < 105; i += 1) {
      await request(app.getHttpServer()).get('/health/live').expect(200);
    }
  });
```

- [ ] **Step 12: Verify C-D4 by mutation**

Temporarily remove `@SkipThrottle()` from `live()`. Run `npm run test:e2e -- auth-throttle`.
Expected: FAIL at request 101 with a 429, on the `does not rate-limit /health/live` assertion — the one that names the property.
**Restore `@SkipThrottle()` and re-run to confirm PASS.** Record both outcomes.

- [ ] **Step 13: Verify C-D3's unit half by mutation**

Temporarily change `live()` to `async live(): Promise<LivenessStatus> { await this.prisma.$queryRaw\`SELECT 1\`; return { status: 'ok' }; }`. Run `npx jest src/modules/health`.
Expected: FAIL on `still returns ok when the database is unreachable` — the assertion naming liveness-independent-of-database — and on `is synchronous, so it cannot await I/O`.
**Restore and re-run.** Record both outcomes.

- [ ] **Step 14: Full gates**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Read every number. Unit must be ≥ 33 suites and > 430 tests; e2e ≥ 28 suites and > 337 tests. The OpenAPI inventory test in `test/swagger.e2e-spec.ts` asserts a hand-maintained endpoint list — **`/health/live` is a new documented endpoint, so that inventory very likely needs updating from 21 to 22.** If `swagger.e2e-spec.ts` fails, update the inventory to include `/health/live` and record the new count; do not relax the assertion.

- [ ] **Step 15: Commit**

```bash
git add src/modules/health src/bootstrap.ts test/app.e2e-spec.ts test/routing.e2e-spec.ts test/auth-throttle.e2e-spec.ts test/swagger.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat(health): add an unthrottled liveness probe with no database dependency

/health/live does no I/O and is synchronous, so a transient database outage
cannot make a liveness probe restart a container that would have recovered on
its own. /health is unchanged: still a readiness-shaped database check, still
throttled, because it costs a round trip per request.

The global-prefix exclude list needed a second entry: a route is matched by its
full path, so `health` does not cover `health/live`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Negative controls:** C-D3 (unit half, Step 13), C-D4 (Step 12). Both mutation-verified with the mutation and failing assertion recorded.

**Acceptance criteria:**
- `GET /health/live` → `200 {"status":"ok"}`, unprefixed and unversioned; `/api/v1/health/live` and `/api/health/live` both 404.
- `live()` is synchronous and never calls `$queryRaw`, asserted while the mock rejects.
- `/health/live` survives 105 sequential requests under real production limits.
- `/health`'s existing tests unchanged and passing; its throttle intact.
- All four gates green; OpenAPI inventory updated if it moved.

**Independent review focus:**
1. Does `live()` touch **anything** external — database, config, clock, file system? It must not. `new Date()` would be a defect: `check()` has a timestamp, `live()` deliberately does not.
2. Is `@SkipThrottle()` on `live()` only, and is `check()` still throttled? Both skipped is the DoS amplifier the spec forbids (§6.3).
3. Are **both** exclude entries present, and is the `/api/health/live` 404 test present? Without the latter, the prefix bug returns unnoticed.
4. Were Steps 12 and 13's mutations actually run, and did the failures land on the property-naming assertions?
5. Did `/health`'s behaviour change in any way? It must not.

---

## Task 2: Trusted-proxy configuration, C-D1 and C-D2

**Objective:** make `req.ip` — and therefore every throttle bucket — reflect the real client behind a declared number of proxies, with the hop count **required under production** and no default there. Closes G3 and the first `Owner: Phase 6` deferred entry.

**Files:**
- Modify: `src/config/env.validation.ts` (schema opens at :19; append near `MAINTENANCE_LEASE_SECONDS` at :104)
- Modify: `src/config/configuration.ts` (`AppConfig.app` at :2-5; factory `app:` at :71-74)
- Modify: `src/bootstrap.ts` (`configureApp` at :36; insert before `app.use(helmet())` at :39)
- Modify: `src/config/env.validation.spec.ts` (add `validProdEnv()`; **repair the one breaking test**)
- Modify: `src/config/configuration.spec.ts`
- Modify: `.env.example`
- Create: `test/trust-proxy.e2e-spec.ts`

**Interfaces:**
- Consumes: T1's branch and committed work. No symbol.
- Produces: `AppConfig['app']['trustProxyHops']: number`, read via `configService.get('app.trustProxyHops', { infer: true })`. T3 reads nothing from this but edits the same files.

**Dependencies:** **T1 must be complete** — shared file `src/bootstrap.ts`. **Must complete before T3** — shared files `env.validation.ts`, `configuration.ts`, `env.validation.spec.ts`, `.env.example`.

**Spec sections:** §5 (all), §4.3, §4.4, §17.3 (C-D1, C-D2), §19.3 item 1. **DoD:** 9, 15 (15a–15d), 31.

### The hop-count rule — read before writing a line

From spec §5.2, and the single most likely thing to get wrong:

**`1` is the reference topology for tests. It is not a production default and not a value to hardcode.** The prohibition is precise and is **not** a repository-wide ban on the number `1`:

| Forbidden | Permitted and expected |
|---|---|
| `1` as a production default | A test setting `1` explicitly to exercise the one-hop reference topology |
| `1` as a fallback in app or config code | Documentation labelling `1` as the reference topology |
| `1` in `.env.example` | Documentation naming `0` and `2` as equally correct for other chains |
| README presenting `1` as universal or recommended | — |

`.env.example` carries `0`. Under production there is **no default at all**.

**Why a numeric count and never `trust proxy: true`:** `true` makes Express take the **leftmost** `X-Forwarded-For` entry, which is entirely attacker-supplied. The tightest control in this repository is 5/minute on `login`; under `true` that becomes *unlimited*, because a caller rotating the header mints a fresh bucket per request. A numeric `N` counts from the **right**, skipping exactly as many entries as there are appending proxies.

**No custom tracker.** Verified: `@nestjs/throttler@6.5.0`'s `ThrottlerGuard.getTracker()` returns bare `req.ip` (`node_modules/@nestjs/throttler/dist/throttler.guard.js:141-143`), and Express's `req.ip` honours `trust proxy`. One `app.set()` is the entire mechanism. **Do not subclass the guard.**

---

- [ ] **Step 1: Write the failing Joi tests**

In `src/config/env.validation.spec.ts`. First add a production helper next to the existing `validEnv()` — this is the fixture T3 will extend:

```ts
/**
 * The smallest environment that boots under NODE_ENV=production.
 *
 * Production has strictly MORE required variables than development, because
 * three guards have no safe default there (spec section 7). Keeping that
 * difference in one helper is what stops every production test from drifting
 * its own ad-hoc variable list.
 */
function validProdEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return validEnv({
    NODE_ENV: 'production',
    PAYMENT_PROVIDER: 'stripe',
    PAYMENT_API_KEY: 'sk_test_example',
    TRUST_PROXY_HOPS: 0,
    ...overrides,
  });
}
```

Then the tests:

```ts
  describe('TRUST_PROXY_HOPS', () => {
    it('defaults to 0 outside production', () => {
      const { error, value } = validate(validEnv());

      expect(error).toBeUndefined();
      expect(value.TRUST_PROXY_HOPS).toBe(0);
    });

    // C-D6's schema half. The container half is T6.
    //
    // No default under production, and that is the whole policy: neither
    // default is safe. 0 behind a proxy collapses every client into ONE
    // bucket (a trivial DoS against all users, and the load balancer's own
    // probes share it). Anything higher than the real hop count is a full
    // bypass. Which is worse depends on the topology, which the code cannot
    // know — so the deployer must say.
    it('is required under NODE_ENV=production, with no default', () => {
      const env = validProdEnv();
      delete env.TRUST_PROXY_HOPS;

      expect(rejectedKeys(validate(env).error)).toContain('TRUST_PROXY_HOPS');
    });

    it('accepts an explicit 0 under production, for direct-to-Node', () => {
      expect(validate(validProdEnv({ TRUST_PROXY_HOPS: 0 })).error).toBeUndefined();
    });

    it('accepts 2 under production, for a two-proxy chain', () => {
      expect(validate(validProdEnv({ TRUST_PROXY_HOPS: 2 })).error).toBeUndefined();
    });

    // Review Focus 2. Express's `trust proxy` accepts a number OR a string,
    // so an unvalidated 'abc' becomes a HOSTNAME MATCHER that trusts nothing
    // while looking configured — no error, no log, no trust. Each of these
    // must be refused at boot instead.
    it.each([
      ['a non-numeric string', 'abc'],
      ['a negative count', -1],
      ['a fractional count', 1.5],
      ['an empty string', ''],
    ])('rejects %s', (_label, bad) => {
      expect(
        rejectedKeys(validate(validEnv({ TRUST_PROXY_HOPS: bad })).error),
      ).toContain('TRUST_PROXY_HOPS');
    });
  });
```

- [ ] **Step 2: Repair the one pre-existing test this breaks**

`src/config/env.validation.spec.ts:246` — `accepts the stripe provider under NODE_ENV=production when a key is set` — expects `error` to be `undefined` while building its env from `validEnv()`, which has no `TRUST_PROXY_HOPS`. Once the guard lands, that test **fails**. This is expected and must be repaired, not worked around:

```ts
    it('accepts the stripe provider under NODE_ENV=production when a key is set', () => {
      const { error } = validate(validProdEnv());

      expect(error).toBeUndefined();
    });
```

The neighbouring test at :238 (`rejects the fake provider under NODE_ENV=production`) needs **no change**: it asserts `error?.message` *contains* `PAYMENT_PROVIDER`, and `abortEarly: false` keeps that key in the message alongside the new one.

- [ ] **Step 3: Run the Joi tests to verify they fail**

Run: `npx jest src/config/env.validation --verbose`
Expected: FAIL — `TRUST_PROXY_HOPS` is not in the schema, so it defaults to `undefined` and is never rejected.

- [ ] **Step 4: Add the Joi rule**

In `src/config/env.validation.ts`, after `CORS_ORIGIN` at :25:

```ts
  // Phase 6. Express's `trust proxy`, and therefore every throttle bucket:
  // ThrottlerGuard.getTracker() returns bare `req.ip`, and `req.ip` honours
  // this setting. One app.set() is the whole mechanism — no custom tracker.
  //
  // REQUIRED under production, with no default, because NEITHER default is
  // safe. 0 behind a proxy makes Express report the PROXY's address for every
  // request, collapsing all clients into one bucket: the 5/min limit on login
  // becomes 5/min for the entire internet, and the load balancer's own health
  // probes share that budget. Anything HIGHER than the real chain depth is a
  // full bypass, because Express counts past the proxy-appended entries into
  // attacker-supplied ones. Which failure is worse depends on the topology,
  // which this code cannot know. So the deployer states it.
  //
  // Note the asymmetry for whoever operates this: too LOW degrades
  // availability loudly (everyone throttled together); too HIGH removes the
  // control silently. Too high is the dangerous direction.
  //
  // The value is the number of proxies that will APPEND to X-Forwarded-For.
  // 0 for direct-to-Node, 1 for one reverse proxy, 2 for a CDN in front of a
  // load balancer. There is no universally correct value and 1 is not a
  // recommendation — it is only the reference topology the tests use.
  TRUST_PROXY_HOPS: Joi.number()
    .integer()
    .min(0)
    .default(0)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.number().integer().min(0).required(),
    }),
```

**On the `then` branch and `Joi.override`:** `PAYMENT_PROVIDER` above carries a warning that a `then` branch is *concatenated*, which is why `Joi.override` is load-bearing there — a bare `Joi.valid('stripe')` would *add* to the allowed set. That trap is specific to allow-list concatenation. `required()` does not share it: measured against the installed Joi, `.default(0)` plus a concatenated `then: required()` neither throws at schema-build time nor leaks the default under production. Step 3→5 is what re-verifies that here; do not add `Joi.override`.

- [ ] **Step 5: Run the Joi tests to verify they pass**

Run: `npx jest src/config/env.validation --verbose`
Expected: PASS, including the repaired test from Step 2.

- [ ] **Step 6: Write the failing configuration test**

In `src/config/configuration.spec.ts`:

```ts
  it('reads TRUST_PROXY_HOPS as a number', () => {
    process.env.TRUST_PROXY_HOPS = '2';

    expect(configuration().app.trustProxyHops).toBe(2);
  });

  it('falls back to 0 when TRUST_PROXY_HOPS is unset', () => {
    delete process.env.TRUST_PROXY_HOPS;

    expect(configuration().app.trustProxyHops).toBe(0);
  });
```

Follow the file's existing env save/restore idiom. If it has none, save `process.env` in `beforeEach` and restore it in `afterEach`:

```ts
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx jest src/config/configuration --verbose`
Expected: FAIL — `app.trustProxyHops` is `undefined`.

- [ ] **Step 8: Add the config key**

`src/config/configuration.ts` — extend the `AppConfig` interface at :2-5:

```ts
  app: {
    port: number;
    env: string;
    trustProxyHops: number;
  };
```

and the factory at :71-74:

```ts
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    env: process.env.NODE_ENV ?? 'development',
    // 0, never 1. Joi requires an explicit value under production, so this
    // fallback is only ever reached outside production (or on a path Joi did
    // not run — a script importing this factory directly). 0 means "trust
    // nothing", which is the right default for a direct-to-Node process and
    // the wrong one behind a proxy — hence the production requirement.
    trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10),
  },
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npx jest src/config/configuration --verbose`
Expected: PASS.

- [ ] **Step 10: Write the failing e2e controls**

Create `test/trust-proxy.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';

/**
 * The trusted-proxy reference-topology controls (C-D1, C-D2) plus the
 * too-high-hop-count hazard (Review Focus 1).
 *
 * TRUST_PROXY_HOPS is set to 1 here DELIBERATELY and legitimately: a test
 * needs SOME topology to assert against, and one proxy hop is the spec's
 * reference topology (section 5.1). The value is injected by this test, local
 * to it, and carries NO authority over any deployment — see spec section 5.2
 * and DoD 15d. It is not a default and must never become one.
 *
 * Why the env var rather than a harness option: `test/` is the one place
 * outside `src/config/` allowed to read and write process.env, and
 * `createTestApp()` compiles AppModule fresh on every call, so a value set
 * before the call is picked up by ConfigModule. `test/setup-e2e.ts` already
 * uses exactly this idiom for MAINTENANCE_JOBS_ENABLED. The save/restore is
 * mandatory: suites share one process under maxWorkers: 1.
 */
describe('trusted proxy (e2e)', () => {
  const originalHops = process.env.TRUST_PROXY_HOPS;

  afterAll(() => {
    if (originalHops === undefined) {
      delete process.env.TRUST_PROXY_HOPS;
    } else {
      process.env.TRUST_PROXY_HOPS = originalHops;
    }
  });

  async function appWithHops(hops: string): Promise<INestApplication<App>> {
    process.env.TRUST_PROXY_HOPS = hops;

    return createTestApp();
  }

  // The 5/min route, which is the tightest control in the repository and the
  // one an attacker would grind.
  const login = (
    app: INestApplication<App>,
    forwardedFor: string,
  ): request.Test =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', forwardedFor)
      .send({ email: 'nobody@example.test', password: 'Test1234!' });

  describe('one-hop reference topology', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await appWithHops('1');
    });

    afterAll(async () => {
      await app.close();
    });

    /**
     * C-D1. Hop counting from the RIGHT: a forged prefix cannot mint a bucket.
     *
     * The forged prefix ROTATES on every request. With one real proxy in
     * front, that proxy appends the true client address, so the rightmost
     * entry is the only trustworthy one and the bucket must key on it.
     *
     * A SINGLE-ENTRY X-Forwarded-For would make this control VACUOUS: with one
     * entry and hops=1, the forged value IS the rightmost entry, so it is the
     * client by construction and the test would pass against `trust proxy:
     * true` as well. The two-entry shape is the whole point.
     */
    it('ignores a rotating forged prefix and still throttles the real client', async () => {
      for (let i = 0; i < 5; i += 1) {
        await login(app, `9.9.9.${i}, 10.0.0.5`).expect(401);
      }

      await login(app, '9.9.9.99, 10.0.0.5').expect(429);
    });

    /**
     * C-D2. Independent buckets per real client — proves we did not simply
     * collapse everyone into one bucket and call it safe. Without any
     * `trust proxy` setting both of these key on the socket address and share
     * a bucket, so the second client would already be blocked.
     */
    it('gives two different real clients independent buckets', async () => {
      for (let i = 0; i < 5; i += 1) {
        await login(app, `9.9.9.9, 10.0.0.11`).expect(401);
      }

      await login(app, '9.9.9.9, 10.0.0.11').expect(429);

      // A different rightmost entry: a different client, a fresh budget.
      await login(app, '9.9.9.9, 10.0.0.12').expect(401);
    });
  });

  /**
   * Review Focus 1 — the too-high hop count, demonstrated rather than
   * described.
   *
   * The spec says too high is the dangerous direction. Here it is: with
   * hops=2 but only ONE appending proxy, Express counts past the
   * proxy-appended entry into the attacker-supplied one, so a rotating
   * prefix mints a fresh bucket every request and the 5/min control is gone.
   *
   * This test asserts the BYPASS, so it documents the hazard and will fail
   * loudly if a future change to the hop arithmetic silently "fixes" it. It
   * is not an endorsement of hops=2.
   */
  describe('a hop count higher than the real chain depth', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await appWithHops('2');
    });

    afterAll(async () => {
      await app.close();
    });

    it('lets a rotating forged prefix bypass the limit entirely', async () => {
      for (let i = 0; i < 8; i += 1) {
        await login(app, `9.9.9.${i}, 10.0.0.5`).expect(401);
      }
    });
  });
});
```

- [ ] **Step 11: Run them to verify they fail**

Run: `npm run test:e2e -- trust-proxy`
Expected: FAIL. With no `trust proxy` set, every request keys on the loopback socket address, so C-D1's loop 429s early and C-D2's "different client" request gets 429 instead of 401.

- [ ] **Step 12: Apply the setting in `configureApp()`**

`src/bootstrap.ts`, as the **first** statement in `configureApp()` (before `app.use(helmet())` at :39):

```ts
  // Trusted proxy, and therefore every throttle bucket: ThrottlerGuard's
  // getTracker() returns bare `req.ip`, and Express's `req.ip` honours this.
  // No custom tracker, no guard subclass.
  //
  // A NUMBER, never `true`. `true` makes Express take the LEFTMOST
  // X-Forwarded-For entry, which is entirely attacker-supplied — the 5/min
  // limit on login would become unlimited, since rotating the header mints a
  // fresh bucket per request. A numeric N counts from the RIGHT, skipping
  // exactly as many entries as there are proxies that will append.
  //
  // It lives here, in configureApp(), and not in main.ts, because this is the
  // configuration seam the e2e harness also calls. Setting it in main.ts would
  // make the production path and the tested path diverge — the exact failure
  // this function exists to prevent — and the C-D1/C-D2 controls in
  // test/trust-proxy.e2e-spec.ts would be asserting against a different app
  // than the one that ships.
  //
  // getHttpAdapter().getInstance() keeps this function's INestApplication
  // signature; `set` is an Express method, and widening the parameter to
  // NestExpressApplication would ripple into the e2e harness's typing for no
  // benefit.
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', configService.get('app.trustProxyHops', { infer: true }));
```

- [ ] **Step 13: Run the e2e controls to verify they pass**

Run: `npm run test:e2e -- trust-proxy`
Expected: PASS, all four tests.

- [ ] **Step 14: Mutation-verify C-D1 and C-D2**

**Mutation A — `trust proxy: true`.** Replace the config value with the literal `true`. Run `npm run test:e2e -- trust-proxy`.
Expected: **C-D1 FAILS** on `ignores a rotating forged prefix and still throttles the real client` — the final `.expect(429)` gets 401, because each rotated prefix became its own bucket. That is the assertion naming the property. C-D2 may still pass; that is fine and expected — C-D1 is the control for this failure mode.

**Mutation B — remove the `app.set()` entirely.** Run again.
Expected: **C-D2 FAILS** on `gives two different real clients independent buckets` — the final `.expect(401)` gets 429, because both clients share the socket-address bucket.

**Mutation C — the vacuity check.** Restore the correct code, then temporarily rewrite C-D1's requests to a single-entry header (`9.9.9.${i}` with no `, 10.0.0.5`). Run again.
Expected: the test **PASSES while proving nothing** — demonstrating why the two-entry shape is mandatory. Revert this mutation immediately and keep the two-entry form.

**Restore all three mutations and re-run to confirm PASS.** Record each mutation, the assertion that failed, and that it was the property-naming one.

- [ ] **Step 15: Update `.env.example`**

Add after the `CORS_ORIGIN` block:

```
# Trusted proxy (Phase 6)
# The number of reverse proxies that will APPEND to X-Forwarded-For before a
# request reaches this process. It governs `req.ip`, and therefore every rate
# limit bucket.
#
# REQUIRED under NODE_ENV=production, where it has NO default: neither default
# is safe. 0 behind a proxy makes Express report the proxy's address for every
# request, so the 5/min limit on login becomes 5/min for the whole internet.
# A value higher than the real chain depth is worse — Express counts past the
# proxy-appended entries into attacker-supplied ones and the limit is bypassed
# silently. Too high is the dangerous direction.
#
# Set it to match YOUR topology: 0 for direct-to-Node, 1 for one reverse
# proxy, 2 for a CDN in front of a load balancer. There is no universally
# correct value, and 1 is not a recommendation — it is only the reference
# topology this project's tests use.
TRUST_PROXY_HOPS=0
```

**It must read `0`.** DoD 15b.

- [ ] **Step 16: Full gates**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

e2e gains one suite (`trust-proxy`). Confirm no other suite regressed — a hop count of `0` outside production keeps every existing suite byte-identical in behaviour, and the full suite passing unchanged is the evidence for that (spec R3).

- [ ] **Step 17: Commit**

```bash
git add src/config src/bootstrap.ts .env.example test/trust-proxy.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat(config): trust a declared number of proxy hops, required in production

ThrottlerGuard keys on req.ip, and req.ip honours Express's `trust proxy`, so
one app.set() in configureApp() is the whole mechanism — no custom tracker.

A NUMBER, never `true`: `true` takes the leftmost X-Forwarded-For entry, which
is attacker-supplied, and would make the 5/min login limit unlimited. A numeric
count works from the right, skipping exactly the proxy-appended entries.

Required under production with no default, because neither default is safe: 0
behind a proxy collapses every client into one bucket, and too high is a silent
bypass. The deployer states the topology. 1 is the tests' reference topology
and is not a default anywhere.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Negative controls:** C-D1 (Mutation A), C-D2 (Mutation B), plus the C-D1 vacuity check (Mutation C) and Review Focus 1's bypass demonstration.

**Acceptance criteria:**
- `TRUST_PROXY_HOPS` required under production with no default; defaults to `0` elsewhere; rejects `'abc'`, `-1`, `1.5`, `''`.
- `.env.example` reads `TRUST_PROXY_HOPS=0`.
- No `1` as a default or fallback in `src/` or `.env.example`; `1` appears in `test/trust-proxy.e2e-spec.ts` only, labelled as the reference topology.
- `app.set('trust proxy', …)` is in `configureApp()`, not `main.ts`.
- `env.validation.spec.ts:246` repaired via `validProdEnv()`.
- C-D1 and C-D2 pass and are mutation-verified; all four gates green.

**Independent review focus:**
1. Is the value a **number** from config, never `true`, never a hardcoded literal? Grep `src/` for `trust proxy` and read every hit.
2. Is `1` absent as a default/fallback anywhere in `src/` and `.env.example`, while **permitted** in the test? Flagging the test's `1` as a violation is itself the error — DoD 15d.
3. Is the setting in `configureApp()` so the e2e harness exercises it? In `main.ts` it would be untested and the controls would assert against a different app.
4. Does C-D1 use a **two-entry** `X-Forwarded-For` with a **rotating** prefix? A single entry makes it vacuous (Mutation C).
5. Was Mutation A actually run, and did C-D1 fail on the `.expect(429)` that names the property?
6. Is `Joi.override` **absent** from the new rule? It is needed for allow-lists, not for `required()`.
7. Did any existing e2e suite change behaviour? It must not.

---

## Task 3: Production configuration guards, Swagger, TZ, boot topology log

**Objective:** make the three worst realistic misconfigurations abort at boot or be structurally absent, and let a container say what it thinks it is. Closes G7, G8, G11.

**Files:**
- Modify: `src/config/env.validation.ts` (`CORS_ORIGIN` at :25)
- Modify: `src/config/env.validation.spec.ts` (extend `validProdEnv()`; add CORS tests)
- Modify: `src/main.ts` (Swagger at :13-20; add the boot log before `app.listen()` at :24)
- Modify: `Dockerfile` (add `ENV TZ=UTC` in the runtime stage, near `ENV NODE_ENV=production` at :15)
- Modify: `.env.example` (note the production CORS requirement)

**Interfaces:**
- Consumes: T2's `validProdEnv()` helper and `AppConfig['app']['trustProxyHops']` (the boot log prints it).
- Produces: nothing later tasks import. T6 asserts C-D7 and C-D8 against this behaviour.

**Dependencies:** **T2 must be complete** — shares `env.validation.ts`, `env.validation.spec.ts`, `.env.example`. **Do not dispatch T2 and T3 concurrently.**

**Spec sections:** §7 (all), §8, §16, §17.3 (C-D7, C-D8), §19.3 items 1–3. **DoD:** 16, 17 (TZ half), 19, 29.

---

- [ ] **Step 1: Write the failing CORS Joi tests**

In `src/config/env.validation.spec.ts`:

```ts
  describe('CORS_ORIGIN', () => {
    it("defaults to '*' outside production", () => {
      const { error, value } = validate(validEnv());

      expect(error).toBeUndefined();
      expect(value.CORS_ORIGIN).toBe('*');
    });

    // C-D7's schema half. The container half is T6.
    //
    // The weakest of this phase's three guards, and the spec says so: this
    // API authenticates with bearer tokens, not cookies, so '*' leaks no
    // credential by itself and no browser attaches one automatically. What
    // makes it worth forbidding is the combination with a published admin
    // surface: a wildcard origin lets ANY origin script admin routes with a
    // token obtained some other way.
    it("rejects '*' under NODE_ENV=production", () => {
      const env = validProdEnv({ CORS_ORIGIN: '*' });

      expect(rejectedKeys(validate(env).error)).toContain('CORS_ORIGIN');
    });

    it('is required under NODE_ENV=production, with no default', () => {
      const env = validProdEnv();
      delete env.CORS_ORIGIN;

      expect(rejectedKeys(validate(env).error)).toContain('CORS_ORIGIN');
    });

    it('accepts an explicit origin under production', () => {
      expect(
        validate(validProdEnv({ CORS_ORIGIN: 'https://shop.example.test' }))
          .error,
      ).toBeUndefined();
    });
  });
```

- [ ] **Step 2: Extend `validProdEnv()` with the new production requirement**

T2 created the helper; T3 adds the variable production now requires, so every other production test keeps passing:

```ts
function validProdEnv(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return validEnv({
    NODE_ENV: 'production',
    PAYMENT_PROVIDER: 'stripe',
    PAYMENT_API_KEY: 'sk_test_example',
    TRUST_PROXY_HOPS: 0,
    CORS_ORIGIN: 'https://shop.example.test',
    ...overrides,
  });
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx jest src/config/env.validation --verbose`
Expected: FAIL — `CORS_ORIGIN` still defaults to `'*'` under production and is never rejected.

- [ ] **Step 4: Make `CORS_ORIGIN` production-strict**

`src/config/env.validation.ts:25` — replace:

```ts
  CORS_ORIGIN: Joi.string().default('*'),
```

with:

```ts
  // Phase 6. '*' is forbidden under production, and this is deliberately the
  // WEAKEST of the phase's three guards — recorded as such rather than
  // oversold. Bearer-token auth means a wildcard leaks no credential by
  // itself and no browser attaches one automatically. What earns the guard is
  // the combination with an API that has an admin surface: a wildcard origin
  // lets any origin script those routes with a token obtained some other way.
  //
  // Required under production, so the value is always a deliberate choice. If
  // a deployment genuinely needs a wildcard it must amend the Phase 6 spec,
  // which is the intended friction.
  CORS_ORIGIN: Joi.string()
    .default('*')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid('*').required(),
    }),
```

`invalid()` and `required()` are not allow-list concatenations, so no `Joi.override` is needed here either.

- [ ] **Step 5: Run them to verify they pass**

Run: `npx jest src/config/env.validation --verbose`
Expected: PASS, with every pre-existing production test still green thanks to Step 2.

- [ ] **Step 6: Gate Swagger on production**

`src/main.ts` — replace :13-20:

```ts
  const swaggerConfig = new DocumentBuilder()
    .setTitle('E-commerce Backend API')
    .setDescription('API documentation for the e-commerce backend')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);
```

with:

```ts
  const configService = app.get(ConfigService<AppConfig, true>);
  const env = configService.get('app.env', { infer: true });
  const swaggerEnabled = env !== 'production';

  // Not served under production, and the reason is the mounting mechanism
  // rather than a general preference for quiet production builds.
  // SwaggerModule.setup() installs EXPRESS middleware, so it sits OUTSIDE the
  // Nest guard chain: neither JwtAuthGuard nor RolesGuard applies to it. An
  // ungated production container therefore publishes the complete API
  // surface, including every admin route and the maintenance trigger
  // POST /api/v1/admin/maintenance/:job/run.
  //
  // Gated on NODE_ENV with no new environment variable (D6): a
  // SWAGGER_ENABLED flag would be a knob with no current consumer. If a
  // staging deployment later wants docs under a production NODE_ENV, adding
  // the variable then is a one-line change made for a real reason.
  //
  // This does not affect test/swagger.e2e-spec.ts: that suite builds its own
  // document with SwaggerModule.createDocument and never requests this route.
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('E-commerce Backend API')
      .setDescription('API documentation for the e-commerce backend')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, swaggerDocument);
  }
```

Then replace the now-duplicated `configService`/`port` lines at :22-24 with just:

```ts
  const port = configService.get('app.port', { infer: true });
  await app.listen(port);
```

- [ ] **Step 7: Add the boot topology log**

Immediately after `await app.listen(port);` in `src/main.ts`:

```ts
  // What does this container think it is. One line, answering the first
  // question anyone asks of a misbehaving deployment, and the entire
  // observability content of Phase 6 (D9) — structured logging, correlation
  // ids, metrics and tracing are all deferred with reasons.
  //
  // LEAKS NO SECRET, and the omissions are the point: no JWT_SECRET, no
  // PAYMENT_API_KEY, no PAYMENT_WEBHOOK_SECRET, and NO DATABASE_URL — that
  // one embeds a password and is the most tempting value to include here.
  // Every existing "never log" rule applies to this line.
  new Logger('Bootstrap').log(
    `Serving on port ${port} | env=${env} | ` +
      `trustProxyHops=${configService.get('app.trustProxyHops', { infer: true })} | ` +
      `paymentProvider=${configService.get('payments.provider', { infer: true })} | ` +
      `maintenanceJobs=${configService.get('maintenance.jobsEnabled', { infer: true }) ? 'enabled' : 'disabled'} | ` +
      `swagger=${swaggerEnabled ? 'served at /api/docs' : 'not served'}`,
  );
```

Add `Logger` to the `@nestjs/common` import in `main.ts`.

- [ ] **Step 8: Add `ENV TZ=UTC` to the Dockerfile**

`Dockerfile`, in the **runtime** stage beside `ENV NODE_ENV=production` at :15:

```dockerfile
ENV NODE_ENV=production
# Declared, not changed: alpine already defaults to UTC, so this does not move
# any schedule. It makes "03:00" in the runbook unambiguous and stops a future
# base image with a different default from silently moving the retention purge
# (MAINTENANCE_PURGE_CRON=0 0 3 * * *).
ENV TZ=UTC
```

- [ ] **Step 9: Note the production CORS requirement in `.env.example`**

Replace the `CORS_ORIGIN=*` line's surroundings with:

```
# CORS
# '*' is fine for local development and is REJECTED under NODE_ENV=production,
# where this variable is required with no default. Set it to the exact origin
# that will call this API.
CORS_ORIGIN=*
```

- [ ] **Step 10: Run the full unit suite**

Run: `npm test`
Expected: PASS. If `src/main.ts` has no unit test, nothing new runs here — its behaviour is proven by C-D7/C-D8 in T6, which is the point of the container smoke test.

- [ ] **Step 11: Mutation-verify the CORS guard**

Remove `.invalid('*')` from the rule. Run `npx jest src/config/env.validation`.
Expected: FAIL on `rejects '*' under NODE_ENV=production`.
Then remove the whole `.when(...)` clause. Run again.
Expected: FAIL on **both** `rejects '*' …` and `is required under NODE_ENV=production, with no default`.
**Restore and re-run.** Record both.

- [ ] **Step 12: Mutation-verify the Swagger gate locally**

Temporarily change `swaggerEnabled` to the literal `true`, then build and boot under production settings:

```bash
npm run build
NODE_ENV=production \
  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ecommerce_dev" \
  JWT_SECRET="$(printf 'x%.0s' {1..40})" \
  PAYMENT_PROVIDER=stripe PAYMENT_API_KEY=sk_test_not_a_real_key \
  PAYMENT_WEBHOOK_SECRET="$(printf 'y%.0s' {1..20})" \
  CORS_ORIGIN=https://shop.example.test TRUST_PROXY_HOPS=1 \
  MAINTENANCE_JOBS_ENABLED=false \
  node dist/main &
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/docs
kill %1
```

Expected with the mutation: `200`. **Restore the gate**, rebuild, repeat: expect `404`. Record both. (T6 makes this an automated control inside the image; this step is the local proof before the CI wiring exists.)

- [ ] **Step 13: Verify the boot log leaks no secret — Review Focus 4**

With the same command as Step 12 (gate restored), capture the output and assert the absence of every secret:

```bash
npm run build
NODE_ENV=production \
  DATABASE_URL="postgresql://postgres:supersecretpw@localhost:5432/ecommerce_dev" \
  JWT_SECRET="UNIQUEJWTCANARY0000000000000000000000" \
  PAYMENT_PROVIDER=stripe PAYMENT_API_KEY=sk_test_UNIQUEKEYCANARY \
  PAYMENT_WEBHOOK_SECRET=UNIQUEHOOKCANARY1234 \
  CORS_ORIGIN=https://shop.example.test TRUST_PROXY_HOPS=1 \
  MAINTENANCE_JOBS_ENABLED=false \
  node dist/main > /tmp/boot.log 2>&1 &
sleep 4
kill %1
for canary in supersecretpw UNIQUEJWTCANARY UNIQUEKEYCANARY UNIQUEHOOKCANARY; do
  if grep -q "$canary" /tmp/boot.log; then echo "LEAK: $canary"; exit 1; fi
done
grep -q 'trustProxyHops=1' /tmp/boot.log || { echo 'topology line missing'; exit 1; }
echo 'no leak; topology line present'
```

Expected: `no leak; topology line present`. If any canary appears, the log line is wrong — fix the line, never the test.

- [ ] **Step 14: Full gates**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

e2e must be unchanged in count and all green: these guards bite only under `NODE_ENV=production`, and e2e runs under `NODE_ENV=test`.

- [ ] **Step 15: Commit**

```bash
git add src/config src/main.ts Dockerfile .env.example
git commit -m "$(cat <<'EOF'
feat(config): abort production boot on unsafe CORS, stop publishing docs

Swagger mounts as Express middleware, OUTSIDE the Nest guard chain, so an
ungated production container published the whole API surface including the
admin routes and the maintenance trigger. Gated on NODE_ENV with no new
variable; the OpenAPI inventory suite builds its own document and is unaffected.

CORS_ORIGIN is now required under production and rejects '*'. Recorded as the
weakest of the three guards: bearer auth means a wildcard leaks no credential
by itself, but combined with an admin surface it lets any origin script those
routes with a token obtained elsewhere.

TZ=UTC is declared rather than changed, so "03:00" for the retention purge is
unambiguous and a future base image cannot move it silently. The boot line
names the resolved topology and deliberately omits DATABASE_URL, which embeds
a password.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Negative controls:** C-D7 (Step 11, schema half), C-D8 (Step 12, local half), Review Focus 4 (Step 13). Container halves of C-D7/C-D8 land in T6.

**Acceptance criteria:**
- `CORS_ORIGIN` required and `'*'`-rejected under production; `'*'` still the default elsewhere.
- `/api/docs` returns 404 under `NODE_ENV=production`, 200 otherwise.
- `ENV TZ=UTC` in the runtime stage.
- The boot line prints env, port, hops, provider, maintenance state, Swagger state — and **no** secret, proven against four canaries.
- `validProdEnv()` extended; all pre-existing production tests green.
- All four gates green; e2e count unchanged.

**Independent review focus:**
1. Does the boot line include `DATABASE_URL`, a secret, or any value derived from one? Step 13's canaries must actually have been run.
2. Is the Swagger gate on `NODE_ENV` with **no new env var** (D6)? A `SWAGGER_ENABLED` variable is scope creep.
3. Did `swagger.e2e-spec.ts` stay green? If it broke, the gate was applied to document *construction* rather than route *mounting*.
4. Is `Joi.override` absent from the CORS rule, and is `validProdEnv()` extended rather than each test patched ad hoc?
5. Is `ENV TZ=UTC` in the **runtime** stage, not the build stage?
6. Was Step 12 run in **both** directions — 200 with the mutation, 404 without?

---

## Task 4: Dockerfile migrate stage, HEALTHCHECK, `.dockerignore`

**Objective:** ship a migration artifact built from the same Dockerfile and commit as the runtime image, add a health check that is *verified to work*, and stop the build layer carrying the gitignored SDD ledger. Closes G9 and the second half of G5.

**Files:**
- Modify: `Dockerfile` (28 lines; `FROM … AS build` at :2, `FROM … AS runtime` at :13, `CMD` at :28)
- Modify: `.dockerignore` (7 lines)

**Interfaces:**
- Consumes: nothing. **T4 is genuinely independent of T1–T3** and may run at any point before T5 and T6.
- Produces: two build targets, `migrate` and `runtime`, consumed by T5 (compose) and T6 (CI). `runtime` must remain the **default** target.

**Dependencies:** none. **Must complete before T5 and T6.**

**Spec sections:** §9 (all), §10.5, §15.2, §17.3 (C-D10, C-D11), §19.3 item 2. **DoD:** 6, 17, 18, 21. **C-D10 and DoD 12 moved to Task 4a** after this task disproved their premise.

### Two traps verified at plan time

**Trap 1 — stage order decides the default target.** `runtime` is currently the **last** stage in the Dockerfile, and `docker build` with no `--target` builds the last stage. Appending `FROM build AS migrate` at the end would make **`migrate` the default**, so a bare `docker build .` — including anything outside this repository that does it — would silently produce a migration container instead of the server. **Place the `migrate` stage between `build` and `runtime`** so `runtime` stays last, *and* pass `--target` explicitly everywhere. Belt and braces.

**Trap 2 — `wget` is unverified here.** The `HEALTHCHECK` relies on `wget`, which appears **nowhere** in the current Dockerfile. It is expected via busybox in `node:20-alpine`, but that expectation is unverified in this repository and must not be assumed. A `HEALTHCHECK` whose command is missing reports **unhealthy**, not an error — so a container serving perfectly gets marked unhealthy and restarted forever with nothing in the application log naming the cause. Step 6 verifies it inside the built image before anything depends on it.

---

- [ ] **Step 1: Verify `wget` exists in the base image — before writing the HEALTHCHECK**

```bash
docker run --rm node:20-alpine sh -c 'command -v wget && wget --help 2>&1 | head -3'
```

Expected: a path such as `/usr/bin/wget` and busybox help output. **If `wget` is absent, stop and report** — do not substitute `curl` (also likely absent) or install a package, since that would add to the runtime image. The fallback, if ever needed, is `node -e` using the already-present Node runtime; adopting it is a spec amendment, not an implementer's choice.

- [ ] **Step 2: Add the `migrate` stage between `build` and `runtime`**

In `Dockerfile`, insert **after** line 10 (`RUN npm run build`) and **before** line 12's `# --- Runtime stage ---`:

```dockerfile
# --- Migration stage ---
# Migrations are a DISCRETE RELEASE COMMAND, never run at application boot.
# This stage exists so that command ships as an artifact instead of depending
# on someone having a checkout and the right CLI.
#
# It reuses `build` verbatim, which already carries devDependencies (the prisma
# CLI is one), prisma/schema.prisma and prisma/migrations. That reuse is the
# point: the migrator and the server come from ONE Dockerfile and ONE source
# commit, which removes the real hazard here — a migration applied from a
# DIFFERENT checkout than the running image, where the two drift and nothing
# detects it.
#
# It is deliberately NOT the last stage. `docker build` with no --target builds
# the last stage, so putting this after `runtime` would silently make a bare
# `docker build .` produce a migration container instead of the server. Keep
# `runtime` last, and pass --target explicitly anyway.
#
# Fat by design: it inherits the whole build stage. Acceptable for an image
# that never serves traffic and is never published.
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

```

- [ ] **Step 3: Add the HEALTHCHECK to the runtime stage**

In `Dockerfile`, between `EXPOSE 3000` (:27) and `CMD` (:28):

```dockerfile
# Container liveness, pointed at /health/live and NEVER at /health.
#
# /health queries the database and 503s when it is unreachable. Tying restarts
# to that turns a transient database blip into an UNBOOTABLE CRASH LOOP:
# PrismaService.onModuleInit() calls $connect(), whose failure exits the
# process, so the restart cannot succeed while the database is down — where the
# running container would have reconnected on its own.
#
# wget comes from busybox in this base image and nothing else here uses it, so
# its presence is verified explicitly inside the built image rather than
# assumed (control C-D11). A HEALTHCHECK whose command is MISSING reports
# `unhealthy` rather than erroring, so this would otherwise fail silently and
# look like an application fault.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health/live || exit 1
```

- [ ] **Step 4: Tighten `.dockerignore`**

Append to `.dockerignore`:

```
docs
test
.superpowers
.claude
.vscode
*.stackdump
```

`.superpowers` is **gitignored**, so `COPY . .` was pulling the SDD ledger — invisible in git review — into the build layer. `*.stackdump` keeps the untracked `bash.exe.stackdump` out of the build context without touching the file itself.

- [ ] **Step 5: Verify `runtime` is still the default target**

```bash
grep -n '^FROM' Dockerfile
```

Expected order: `build` (:2), `migrate`, `runtime` — **`runtime` last**. If `migrate` is last, Trap 1 is live; move it.

- [ ] **Step 6: Build both targets and verify the base-image assumptions — Review Focus 5**

```bash
docker build --target runtime -t ecommerce-backend:local-runtime .
docker build --target migrate -t ecommerce-backend:local-migrate .
docker build -t ecommerce-backend:local-default .
```

All three must succeed. The third proves the default target still works after the `.dockerignore` tightening — `nest build` is safe because `tsconfig.build.json` excludes `test` and `**/*spec.ts`, and `npx prisma generate` is safe because `prisma/` is not excluded. Both were assumptions until this step.

Then confirm the default is `runtime`, not `migrate`:

```bash
docker inspect -f '{{json .Config.Cmd}}' ecommerce-backend:local-default
```

Expected: `["node","dist/main"]`. If it prints the prisma command, Trap 1 is live.

- [ ] **Step 7: Verify the HEALTHCHECK command runs inside the final image — C-D11, part 1**

```bash
docker run --rm --entrypoint sh ecommerce-backend:local-runtime -c \
  'command -v wget && echo WGET_PRESENT'
```

Expected: a path and `WGET_PRESENT`. This is the specific check that catches a missing binary, and it must run against the **runtime** image — the base image having `wget` (Step 1) does not prove the final image does, since the runtime stage installs and copies over it.

Also confirm the configured check is registered and targets the right endpoint:

```bash
docker inspect -f '{{json .Config.Healthcheck}}' ecommerce-backend:local-runtime
```

Expected: the test array contains `/health/live`. **If it contains `/health`, that is the defect §6.2 exists to prevent** — and note it would pass every "is it healthy" assertion while carrying exactly that defect, which is why the endpoint is asserted separately.

- [ ] **Step 8: Verify C-D10 — the standard Prisma CLI is absent from the runtime image**

> **SUPERSEDED — this step's premise was measured FALSE during Task 4.**
> `npm ci --omit=dev` does **not** remove the Prisma CLI: `prisma` is an optional
> peer dependency of the production `@prisma/client`, so package-lock marks it
> `devOptional` and `--omit=dev` keeps it (spec §9.2.1). Task 4 inverted this
> control into a truthful assertion of what was measured and struck the false
> claim from its commit message. The boundary is made real by **Task 4a**, and
> C-D10's current definition is spec §17.3. The text below is retained as the
> record of what was believed, not as an instruction — do not execute it.

```bash
docker run --rm --entrypoint sh ecommerce-backend:local-runtime -c \
  'npx --no-install prisma --version' && echo 'UNEXPECTED: CLI resolved' || echo 'EXPECTED: CLI absent'
```

Expected: `EXPECTED: CLI absent`.

And the converse, proving the migrate image *does* carry it:

```bash
docker run --rm --entrypoint sh ecommerce-backend:local-migrate -c \
  'npx --no-install prisma --version'
```

Expected: a Prisma version.

**State the claim precisely.** This establishes that **the standard Prisma migration CLI is absent from the runtime image** — a **tooling boundary, not a capability boundary**. It does **not** prove schema mutation is impossible: `PrismaService` extends `PrismaClient`, which exposes `$executeRaw` and `$executeRawUnsafe` (both present on the generated client), and the database role is whatever `DATABASE_URL` supplies. Today no DDL exists — the only raw SQL in `src/` is the health check's `SELECT 1` — so it is a latent capability, not an exercised one. **No commit message, comment, README line, or deferred-limitations entry produced by this phase may claim mutation is impossible.** A least-privilege database role is what would close it, and that is out of scope (spec §2.2, §19.3 item 8).

- [ ] **Step 9: Mutation-verify C-D11's command check**

Temporarily change the `HEALTHCHECK` to use `curl` instead of `wget`. Rebuild the runtime target, then:

```bash
docker run --rm --entrypoint sh ecommerce-backend:local-runtime -c 'command -v curl && echo PRESENT || echo ABSENT'
```

Expected: `ABSENT` — demonstrating that a plausible-looking check can reference a binary the image does not have, and that Step 7's in-image check is what catches it. **Restore `wget` and rebuild.** Record both.

- [ ] **Step 10: Mutation-verify C-D11's endpoint check**

Temporarily point the `HEALTHCHECK` at `/health`. Rebuild and run `docker inspect -f '{{json .Config.Healthcheck}}'`.
Expected: the test array shows `/health` — and a naive "does the container become healthy" assertion would still pass, since `/health` returns 200 while the database is up. That is exactly why the endpoint is asserted separately (spec §10.5, step 4). **Restore `/health/live` and rebuild.** Record both.

- [ ] **Step 11: Confirm the build layer no longer carries the ledger**

```bash
docker build --target build -t ecommerce-backend:local-build .
docker run --rm --entrypoint sh ecommerce-backend:local-build -c \
  'ls -d /app/.superpowers /app/docs /app/test 2>/dev/null; echo "exit=$?"'
```

Expected: no paths listed. If `.superpowers` appears, `.dockerignore` did not take effect — check for a stale build cache and rebuild with `--no-cache`.

- [ ] **Step 12: Full gates**

```bash
npm run lint:ci && npm run build && npm test
```

No e2e needed: T4 touches no TypeScript. Confirm `git diff --stat` shows **only** `Dockerfile` and `.dockerignore`.

- [ ] **Step 13: Commit**

> **Note — the third paragraph below was substituted at dispatch time.** The
> message originally planned here asserted "The runtime image carries no Prisma
> migration CLI", which Step 8 measured **false**. A commit message may not
> carry a claim measured false, so that paragraph was replaced with the measured
> finding before committing. The text below is what commit `faf07ef` actually
> says. The boundary itself is delivered by Task 4a.

```bash
git add Dockerfile .dockerignore
git commit -m "$(cat <<'EOF'
build: ship a migration image and a verified health check

The migrate target reuses the build stage, so the migrator and the server come
from one Dockerfile and one source commit — which removes the real hazard: a
migration applied from a different checkout than the running image. It sits
BEFORE the runtime stage deliberately, because docker build with no --target
builds the last stage, and a bare build must keep producing the server.

The health check targets /health/live, never /health: tying restarts to a
database query turns a transient outage into an unbootable crash loop. wget is
verified present inside the final image rather than assumed, because a check
whose command is missing reports unhealthy instead of erroring.

C-D10's premise turned out to be false, so the claim is dropped rather than
restated: the runtime image DOES carry the Prisma CLI. `prisma` is an optional
peer dependency of the production `@prisma/client`, so the lockfile marks it
devOptional and `npm ci --omit=dev` keeps it — measured in the built image at
6.19.3. The migrate stage stands on its other reason, which never depended on
this: one Dockerfile, one source commit, no drift.

.dockerignore now excludes the gitignored SDD workspace, which COPY . . was
pulling into the build layer where no git review would see it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Negative controls:** C-D10 (Step 8, with its converse) — **superseded, see Task 4a**; C-D11 parts 1 and 3 (Steps 7, 9, 10). C-D11's Docker-health-status half (part 2) is T6, which is where a container actually runs.

**Acceptance criteria:**
- Three stages in order `build` → `migrate` → `runtime`, with `runtime` **last**; a bare `docker build` yields `CMD ["node","dist/main"]`.
- All three target builds succeed after the `.dockerignore` tightening.
- `wget` verified present **inside the runtime image**; the registered health check names `/health/live`.
- ~~Prisma CLI absent from `runtime`~~, present in `migrate`; the claim recorded as a tooling boundary only. **The absence half is superseded — it was measured false and is delivered by Task 4a.** `migrate` carrying the CLI still holds.
- `.superpowers`, `docs`, `test` absent from the build stage.
- Only `Dockerfile` and `.dockerignore` changed; lint, build, unit green.

**Independent review focus:**
1. Is `runtime` the **last** `FROM`? Verify by `docker inspect`ing a bare build's `Cmd`, not by reading the file.
2. Does the `HEALTHCHECK` name `/health/live`? `/health` is the defect, and it passes a naive health assertion.
3. Was `wget` verified **inside the runtime image** (Step 7), not only the base image (Step 1)?
4. Does any artefact of this task claim schema mutation is impossible? It must not — tooling boundary only.
5. Does `.dockerignore` exclude `.superpowers`, and was Step 11 actually run (possibly needing `--no-cache`)?
6. Did `package.json` change? It must not — the migrate stage adds no dependency, it reuses devDependencies already present in `build`.

---

## Task 4a: Prune the Prisma migration tooling from the runtime image (C-D10 correction)

**Why this task exists.** Task 4 shipped on the premise that `npm ci --omit=dev`
leaves no Prisma CLI in the runtime image. **That premise was measured false
during Task 4** and C-D10 was inverted into a truthful assertion rather than
dropped silently. This task makes the intended boundary real. Spec §9.2 was
rewritten for it; read §9.2.1 through §9.2.4 before touching the Dockerfile.

**Objective:** the runtime image contains no Prisma CLI and no schema engine,
while still serving real database-backed requests; the `migrate` image is
unchanged and still applies every migration to a fresh database.

**Files:**
- Modify: `Dockerfile` — the **runtime stage only**, one `RUN` line plus its
  comment. Nothing else in the file changes.

**Explicitly NOT modified:** `package.json`, `package-lock.json` (spec §9.2.2 —
npm's classification is correct; the image is what is wrong), the `build` stage,
the `migrate` stage, the `HEALTHCHECK`, `ENV TZ=UTC`, `.dockerignore`,
`docker-compose.yml`, `.github/workflows/**`, any TypeScript, any migration.

**Interfaces:**
- Consumes: Task 4's three-stage Dockerfile.
- Produces: a pruned `runtime` target. T5 and T6 consume it. `runtime` must remain
  the **default** (last) target.

**Dependencies:** T4. **Must complete before T5 and T6.**

**Spec sections:** §9.1, §9.2 (all four subsections), §9.3, §15.2, §17.3 (C-D10),
§19.3 items 2 and 9. **DoD:** 12, and the §9.2.4 overclaim prohibition.

### The three traps, named before any step runs

**Trap 1 — the prune must be chained, not a second `RUN`.** A separate `RUN rm -rf`
leaves the deleted bytes in the earlier layer. The final filesystem would lack
them, every absence assertion would pass, and the image would still carry and
transfer the migration tooling — 85.7 MiB of it by `du` on `node_modules`, which
is a disk-usage figure and not an image-size claim. What chaining is worth was
measured separately in Task 4a: `docker images` SIZE **938 MB → 814 MB** and the
`npm ci` layer **526 MB → 436 MB**, with the layer count unchanged at 22. The
three instruments are not interchangeable (spec §9.2.3). Chain it into the
`npm ci --omit=dev` line with `&&`.

**Trap 2 — do not delete the generated client's own query engine.**
`node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node`
(16.7 MB) is what the client loads. `@prisma/engines` holds a *duplicate* of it
alongside the schema engine; that duplicate is what goes. Deleting the generated
one breaks every query, and Step 10's mutation is what proves the assertion would
notice.

**Trap 3 — `new PrismaClient()` succeeding is not evidence.** Instantiating does
not load the engine, so it passes against a broken removal set. The assertion must
be a **real query**, and the end-to-end form must be the app serving an HTTP
request that hits the database.

---

- [ ] **Step 1: Red first — run the new C-D10 assertions against the CURRENT (unpruned) image and record which named assertions fail**

Build the current runtime target and run all five assertions of spec §17.3's
C-D10 **before** editing anything:

```bash
docker build --target runtime -t ecommerce-backend:prepruned .
# (a) filesystem
docker run --rm --entrypoint sh ecommerce-backend:prepruned -c \
  'for p in node_modules/prisma node_modules/.bin/prisma node_modules/@prisma/engines; do [ -e "$p" ] && echo "PRESENT: $p" || echo "absent:  $p"; done; find node_modules -name "schema-engine*" 2>/dev/null'
# (b) invocation
docker run --rm --entrypoint sh ecommerce-backend:prepruned -c \
  'npx --no-install prisma --version >/dev/null 2>&1 && echo "CLI INVOCABLE" || echo "CLI not invocable"'
```

**Expected red:** (a) prints `PRESENT` for all three paths and lists a
`schema-engine*` binary; (b) prints `CLI INVOCABLE`. **Record both verbatim** —
this is the failing evidence the task exists to fix, and it is the first genuine
red phase on this control. Assertions (c1), (c2) and (d) must **pass** already; record
that too, because the point of the task is that they keep passing.

- [ ] **Step 2: Re-measure the layout in the image rather than trusting the spec table**

```bash
docker run --rm --entrypoint sh ecommerce-backend:prepruned -c \
  'du -sh node_modules/prisma node_modules/@prisma/* 2>/dev/null | sort -rh; echo "--- engine binaries ---"; find node_modules -type f \( -name "*.so.node" -o -name "schema-engine*" \) -exec du -h {} \;'
```

Confirm the spec §9.2.3 table against what you see: `node_modules/prisma` ≈50 MB,
`@prisma/engines` ≈35 MB holding **both** `schema-engine-*` and a duplicate
`libquery_engine-*.so.node`, and `node_modules/.prisma/client/` holding its **own**
`libquery_engine-*.so.node`. **If the layout differs from the table, stop and
report** — the removal set is derived from this layout and nothing else.

- [ ] **Step 3: Chain the prune into the runtime stage's `npm ci`**

In `Dockerfile`, in the **runtime** stage, replace:

```dockerfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
```

with:

> **Reconciled with the shipped file.** The block below is the comment as the
> `Dockerfile` now reads, copied verbatim. Two pieces of the originally planned
> text are not in it: the "Never add that generated .so.node to this list"
> sentence (superseded — it was reworded to say the engine must remain), and
> "shipping 85.7 MB of migration tooling" (superseded — replaced by the
> measured layer and image figures). Neither was ever in the committed file.

```dockerfile
COPY package.json package-lock.json ./
# `npm ci --omit=dev` does NOT remove the Prisma CLI, and that is the whole
# reason this line is not just `npm ci --omit=dev`.
#
# `prisma` is declared only in devDependencies, but it is an OPTIONAL PEER
# dependency of @prisma/client, which IS a production dependency. So
# package-lock marks node_modules/prisma `devOptional`, not `dev`, and
# --omit=dev omits only `dev`. Measured in the built image before this line
# existed: `npx --no-install prisma --version` reported 6.19.3. A
# devDependency declaration is not an absence guarantee when a production
# dependency peer-depends on the same package.
#
# @prisma/engines goes with it: it carries schema-engine-* (the binary that
# APPLIES migrations) plus a DUPLICATE query engine. The generated client
# loads its own copy from node_modules/.prisma/client/, copied in below, so
# removing this directory takes the migration engine without touching the
# query path.
#
# That generated .so.node MUST REMAIN in the runtime image: it is the binary
# every Prisma query loads, so the migration-tooling removal must never delete
# it -- not here, and not from any later instruction in this stage. (Naming it
# on this line would in fact delete nothing, since the COPY below has not run
# yet, which is why the rule is "it must remain" rather than "do not add it
# here".)
#
# Chained with && deliberately. A separate RUN would leave the bytes in the
# previous layer: every absence check would still pass while the image kept
# shipping the tooling. Measured on this Dockerfile: the npm ci layer itself
# goes 526MB -> 436MB and the layer count stays 22, so nothing moved to a new
# layer. Whole image, docker images SIZE: 938MB -> 814MB.
#
# This is a TOOLING boundary, not a capability boundary. $executeRaw and
# $executeRawUnsafe remain on the client and the database role is whatever
# DATABASE_URL supplies, so nothing here makes schema mutation impossible.
RUN npm ci --omit=dev \
  && rm -rf node_modules/prisma node_modules/.bin/prisma node_modules/@prisma/engines
```

Do not touch any other line. The `COPY --from=build /app/node_modules/.prisma`
line must stay exactly where it is, **after** this `RUN` — which is also why the
prune cannot accidentally reach the generated client: it does not exist yet at
that point in the build.

- [ ] **Step 4: Rebuild every target and re-confirm the Task 4 invariants**

```bash
docker build --target runtime -t ecommerce-backend:pruned .
docker build --target migrate -t ecommerce-backend:migrate .
docker build -t ecommerce-backend:default .
grep -n '^FROM' Dockerfile
docker inspect -f '{{json .Config.Cmd}}' ecommerce-backend:default
docker inspect -f '{{json .Config.Healthcheck}}' ecommerce-backend:pruned
```

Expected: `build` → `migrate` → `runtime` with **`runtime` last**; default `Cmd`
is `["node","dist/main"]`; the health check still names `/health/live`. Task 4's
properties must survive this task — a regression here is a Critical finding.

- [ ] **Step 5: C-D10 (a) — filesystem absence in the runtime image**

```bash
docker run --rm --entrypoint sh ecommerce-backend:pruned -c \
  'for p in node_modules/prisma node_modules/.bin/prisma node_modules/@prisma/engines; do [ -e "$p" ] && { echo "FAIL PRESENT: $p"; exit 1; } || echo "ok absent: $p"; done; n=$(find node_modules -name "schema-engine*" 2>/dev/null | wc -l); [ "$n" = 0 ] && echo "ok no schema-engine binary" || { echo "FAIL schema-engine found"; exit 1; }'
```

All four lines must be `ok`. **Assert by path and by `find`, not from `npx`
output** — a `find` for `schema-engine*` is what catches the engine arriving under
a path this list does not name.

- [ ] **Step 6: C-D10 (b) — the standard CLI cannot be invoked**

```bash
docker run --rm --entrypoint sh ecommerce-backend:pruned -c \
  'out=$(npx --no-install prisma --version 2>&1); rc=$?; printf "%s\n" "$out" | head -2; echo "npx exit=$rc"'
```

**Capture `npx`'s status before anything else runs.** Piping straight into `head`
and then reading `$?` reports *`head`'s* exit status — which is `0` whether `npx`
succeeded or failed — so the assertion would be vacuous. Assigning to `out` and
saving `$?` on the very next statement, before the pipeline, is what makes the
printed code the one being corroborated.

Expected: a non-zero `npx exit=` and a resolution failure, not a version.
**This assertion is corroboration, never the primary evidence** — it can fail for
reasons unrelated to the prune (a missing `npx`, a changed flag), which is exactly
why Step 5 asserts the filesystem directly.

- [ ] **Step 7: C-D10 (c1) — a real database query from the pruned image, isolating Prisma from app config**

Start a throwaway Postgres on a user-defined network, then run a direct query
through the generated client inside the pruned image: a raw `SELECT 1` **and** at
least two model queries (`user.count()`, `category.count()`), after applying
migrations from the `migrate` image so the tables exist. All must succeed.

This check exists to **discriminate**: if Step 8 fails, this one tells you whether
the cause is the Prisma prune or the application's production configuration.
**Do not** substitute `new PrismaClient()` — Trap 3.

- [ ] **Step 8: C-D10 (c2) — the app itself serves a database-backed request**

Run `ecommerce-backend:pruned` detached on the same network. **Poll
`/health/live` for readiness, then request `/health` once** — do not poll
`/health` in a tight loop. `/health` is **still rate-limited** (100/min ≈ 1.7/s;
see the `app.module.ts` comment quoted under G4), so a tight poll loop earns a
**429** that looks exactly like a Prisma failure. `/health/live` is
`@SkipThrottle()`d (T1), which is why it is the right thing to poll.

`/health` executes `` $queryRaw`SELECT 1` `` through the generated client, so its
200 is the end-to-end proof that the pruned image still reaches PostgreSQL
*through the application*.

**Set the full production environment, with every Joi floor respected**, or this
fails for the wrong reason — which is exactly the failure this step is designed to
tell apart from a Prisma regression. `NODE_ENV=production` is baked into the
image, so the schema requires, and these are the measured constraints from
`src/config/env.validation.ts`:

| Variable | Constraint | Note |
|---|---|---|
| `DATABASE_URL` | `Joi.string().uri().required()` | must be a URI — point it at the Postgres container on the shared network |
| `JWT_SECRET` | `Joi.string().min(32).required()` | **≥32 characters.** A 16-char value aborts boot |
| `TRUST_PROXY_HOPS` | required under production, no default | `0` is correct here — no proxy in front |
| `CORS_ORIGIN` | required under production, `'*'` forbidden | the **third** required variable, added in T3 |
| `PAYMENT_PROVIDER` | `fake` **forbidden** under production | so `stripe` |
| `PAYMENT_API_KEY` | required by the Stripe adapter's constructor | obviously fake; the constructor makes **no** network call (spec §10.2) |
| `PAYMENT_WEBHOOK_SECRET` | ≥16 characters | |

Touch **no** route that calls the provider. On failure, dump `docker logs`
before tearing down, and re-read Step 7's result: if Step 7 passed and this
failed, the cause is configuration, not Prisma.

Also assert `/health/live` 200. Both endpoints, because they prove different
things: `live` proves the process serves, `health` proves Prisma still queries.

- [ ] **Step 9: C-D10 (d) — the converse, in the migrate image, against a FRESH database**

Create a brand-new database (not the one Step 7/8 used), run
`ecommerce-backend:migrate` against it, and require **exit 0**. Then confirm the
five migrations are recorded and the expected tables exist. Also confirm the CLI
*does* resolve in that image.

This is DoD 6's assertion as well as C-D10's converse. A migrate image that cannot
migrate makes the whole boundary pointless.

- [ ] **Step 10: Mutation (i) — drop the prune; (a) and (b) must fail, (c1) must still pass**

Temporarily revert the `RUN` to a bare `npm ci --omit=dev`, rebuild the runtime
target, and re-run Steps 5, 6 and 7.

Expected: Step 5 fails naming the three present paths, Step 6 reports the CLI
invocable, **and Step 7 still passes.** Record all three. The last one is the
point: **(c1)/(c2) alone can never be evidence of the boundary**, so a suite that only
asserted "Prisma still works" would have been green throughout the original
defect. **Restore and rebuild.**

- [ ] **Step 11: Mutation (ii) — delete the generated client's query engine in a disposable image, AFTER the `COPY` that introduces it; (c1) must fail while (a) and (b) still pass**

**Do not add the generated `.so.node` to the runtime stage's `rm -rf` list, and do
not change the production removal set to achieve this mutation.** Adding it there
is a **no-op**: `node_modules/.prisma` does not exist when the chained `RUN`
executes — `COPY --from=build /app/node_modules/.prisma` is a *later* instruction
— so the engine survives and (c1) still passes, proving nothing. Measured exactly
that way during Task 4a: the engine remained at **17,556,136 bytes** and the real
query **passed**. (This is the flip side of **Step 3's ordering note above**: the
prune runs before the `COPY` that creates `node_modules/.prisma`, which is what
makes it safe and what makes the pre-`COPY` mutation inert. Spec §9.2.3's safety
argument is a different one — that the query engine inside `@prisma/engines` is
merely a *duplicate* of the one the client loads, so removing the directory takes
the schema engine with it without touching the query path.)

Mutate in a **disposable image** instead, leaving the tracked `Dockerfile`
byte-identical. Copy it to a throwaway path and insert one line **after** the
`COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma` line:

```dockerfile
RUN rm -f node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node
```

Build that throwaway file under its own tag, then re-run Steps 5, 6 and 7 against
it, substituting the tag in their commands:

```bash
docker build -f <throwaway-dockerfile> -t ecommerce-backend:mut2 .
```

Expected: **Steps 5 and 6 still pass** — the mutation does not touch the
migration tooling, so every absence check and the `find` for `schema-engine*` are
unaffected — **and Step 7 fails on a real query**, with Prisma naming the file it
cannot find: *"Prisma Client could not locate the Query Engine for runtime
linux-musl-openssl-3.0.x … has not copied
libquery_engine-linux-musl-openssl-3.0.x.so.node to the deployment folder."* That
is the control proving the removal set cannot be widened without the query
assertion noticing — the Trap 2 guard, and the reason `new PrismaClient()` is not
an acceptable substitute (it constructs fine against this mutation; only the query
fails — Trap 3).

**Nothing needs restoring in the tracked file, because nothing in it was changed.**
Delete the throwaway Dockerfile and the `ecommerce-backend:mut2` image, and re-run
Step 5 against `ecommerce-backend:pruned` to confirm the real image is the one
back under test.

Note what the two mutations establish together: the absence assertions and the
works-anyway assertion fail on **opposite** mutations, so neither is redundant and
neither can mask the other.

- [ ] **Step 12: Measure the reclaimed size**

```bash
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep ecommerce-backend
```

Record `pruned` against the pre-prune 938 MB. **Do not expect it to match the
85.7 MiB `du` figure** — that measures the deleted paths on disk, not the image
(spec §9.2.3). Task 4a measured **814 MB**, a 124 MB drop. **If the image did not
shrink, Trap 1 is live** — the prune landed in its own layer. Record the actual
number; do not restate the spec's.

- [ ] **Step 13: Scope and gates**

```bash
git diff --stat
npm run lint:ci && npm run build && npm test
```

`git diff --stat` must show **only** `Dockerfile`. `package.json` and
`package-lock.json` must have a zero-line diff. No e2e needed: this task touches
no TypeScript.

- [ ] **Step 14: Commit**

```bash
git add Dockerfile
git commit -m "$(cat <<'EOF'
build: prune the prisma migration tooling from the runtime image

npm ci --omit=dev does not remove it, which is the finding that forced this
change. `prisma` is declared only in devDependencies, but it is an optional
peer dependency of the production @prisma/client, so package-lock marks it
devOptional and --omit=dev keeps it. Measured in the built image beforehand:
npx --no-install prisma --version reported 6.19.3. The image also carried
@prisma/engines, which holds the schema engine that actually applies
migrations.

The prune is chained into the npm ci layer, not a second RUN: a separate layer
would leave the bytes in the image while every absence check still passed.
@prisma/engines' query engine is a duplicate -- the generated client loads its
own copy from node_modules/.prisma/client -- so the query path is untouched,
proven by a real SELECT and model queries against PostgreSQL rather than by a
module load.

This is a tooling boundary, not a capability boundary. $executeRaw and
$executeRawUnsafe remain on the client and the database role is whatever
DATABASE_URL supplies, so nothing here makes schema mutation impossible. The
migration SQL itself also stays in the image; it is data, not tooling.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Negative controls:** C-D10 (a)(b)(c1)(c2)(d) at Steps 5–9, with the two discriminating
mutations at Steps 10 and 11.

**Acceptance criteria:**
- Red evidence recorded from the unpruned image for assertions (a) and (b).
- `node_modules/prisma`, `node_modules/.bin/prisma`, `node_modules/@prisma/engines`
  and every `schema-engine*` binary absent from `runtime`, asserted **by path**.
- The pruned image serves `/health` **200** against real PostgreSQL, and a direct
  raw + model query succeeds.
- The `migrate` image applies all five migrations to a **fresh** database, exit 0.
- Both mutations fail on the assertions that name them, in opposite directions;
  mutation (i)'s edit is restored byte-for-byte, and mutation (ii) never edits the
  tracked `Dockerfile` at all — it runs in a disposable image (Step 11).
- Image shrank, measured by `docker images` SIZE: **938 MB → 814 MB**. (The
  85.7 MiB `du` figure is not an image-size prediction — spec §9.2.3.)
- `runtime` still last; bare build `Cmd` still `["node","dist/main"]`; health check
  still `/health/live`; `ENV TZ=UTC` intact.
- Only `Dockerfile` changed. Lint, build, unit green.
- **No artefact claims schema mutation is impossible, or that the prune is a
  capability boundary.**

**Independent review focus:**
1. Is the prune **chained** into the `npm ci` `RUN`? A second `RUN` passes every
   absence check while shipping the bytes — verify the image actually shrank.
2. Is the generated client's own `libquery_engine-*.so.node` still present, and is
   a **real query** (not `new PrismaClient()`) what proves it?
3. Did both mutations run, fail in **opposite** directions, and get restored?
4. Did Task 4's invariants survive — `runtime` last, bare-build `Cmd`,
   `/health/live`, `ENV TZ=UTC`?
5. Did `package.json`/`package-lock.json` change? They must not.
6. Does any artefact overclaim? Tooling boundary only.
7. Is the `migrate` image genuinely unchanged in capability — CLI present, five
   migrations applied to a fresh database with exit 0?

---

## Task 5: Compose `app` and `migrate` services

**Objective:** make the image runnable locally with one command, without disturbing the development or e2e databases. Closes the local-reproducibility half of G1.

**Files:**
- Modify: `docker-compose.yml` (services `postgres` and `postgres-test`; `volumes:` block at the end)

**Interfaces:**
- Consumes: T4's `migrate` and `runtime` build targets.
- Produces: `docker compose up -d app` and `docker compose run --rm migrate`, documented by T7's runbook.

**Dependencies:** **T4 must be complete.** Independent of T1–T3 as code, but the `app` service's environment must list the variables T2 and T3 made required under production, so **run it after T3** to avoid writing a service definition that cannot boot.

**Spec sections:** §11, §15.3. **DoD:** 20.

---

- [ ] **Step 1: Add the two services**

In `docker-compose.yml`, add **above** the existing `postgres:` service so the file reads application-first:

```yaml
  app:
    build:
      context: .
      # Explicit, even though runtime is the last stage and therefore the
      # default. Naming it means reordering the Dockerfile cannot silently
      # change what compose runs.
      target: runtime
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - '3000:3000'
    environment:
      # The dev database, reached by SERVICE NAME on the compose network --
      # not localhost, which inside a container is the container itself.
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/ecommerce_dev
      # NODE_ENV=production is what the image sets, and these three are
      # required there: fake payments are rejected, CORS may not be '*', and
      # the proxy hop count has no default.
      PAYMENT_PROVIDER: stripe
      PAYMENT_API_KEY: ${PAYMENT_API_KEY:-sk_test_local_not_a_real_key}
      PAYMENT_WEBHOOK_SECRET: ${PAYMENT_WEBHOOK_SECRET:-local-only-webhook-secret}
      JWT_SECRET: ${JWT_SECRET:-local-only-change-me-32-characters-min}
      CORS_ORIGIN: ${CORS_ORIGIN:-http://localhost:3000}
      # 0 == trust nothing, correct for direct-to-container with no proxy in
      # front. Set it to the number of proxies that will append to
      # X-Forwarded-For in whatever topology you actually run.
      TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-0}

  migrate:
    build:
      context: .
      target: migrate
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/ecommerce_dev
    # A one-shot release command, not a service: run it with
    #   docker compose run --rm migrate
    # and require exit 0 before starting `app`. Migrations never run at
    # application boot.
    restart: 'no'
```

- [ ] **Step 2: Verify the compose file parses and the services resolve**

```bash
docker compose config --quiet && echo 'compose config OK'
docker compose config | grep -A2 'target:'
```

Expected: no errors, and both `target: runtime` and `target: migrate` present.

- [ ] **Step 3: Confirm the existing database services are untouched**

```bash
git diff docker-compose.yml | grep '^-' | grep -v '^---'
```

Expected: **no removed lines** other than whitespace. `postgres` must keep `5432` published and its `postgres_data` volume; `postgres-test` must keep `5433` and its `tmpfs`. Breaking the development workflow to look more production-like is a regression.

- [ ] **Step 4: Run the whole thing end to end locally**

```bash
docker compose up -d postgres
docker compose run --rm migrate          # must exit 0
docker compose up -d app
sleep 15
curl -s http://127.0.0.1:3000/health/live
curl -s http://127.0.0.1:3000/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/docs
docker compose ps app                    # STATUS should read (healthy)
```

Expected: `{"status":"ok"}`, then `{"status":"ok","timestamp":"…"}`, then `404` for the docs, and `(healthy)` once the start period elapses.

If `app` reports `(unhealthy)` while `curl` to `/health/live` succeeds, the `HEALTHCHECK` command itself is failing — T4 Step 7's territory. Diagnose with:

```bash
docker inspect -f '{{json .State.Health}}' "$(docker compose ps -q app)"
```

- [ ] **Step 5: Tear down without destroying the dev volume**

```bash
docker compose down
docker volume ls | grep postgres_data   # must still exist
```

Expected: the volume survives. **Never** run `docker compose down -v` here — it would delete the developer's database.

- [ ] **Step 6: Full gates**

```bash
npm run lint:ci && npm run build && npm test
```

No e2e: T5 touches no TypeScript. Confirm `git diff --stat` shows only `docker-compose.yml`.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml
git commit -m "$(cat <<'EOF'
build: add compose app and migrate services

One compose file (D8). A second production-shaped file would demonstrate
network isolation that nothing would ever run, which is the same unverified
configuration this phase exists to remove; the isolation that IS verified is
the CI smoke network.

The dev and e2e databases are untouched: postgres keeps 5432 and its volume,
postgres-test keeps 5433 and its tmpfs. The app service names the variables
production requires, because the image sets NODE_ENV=production and would
otherwise refuse to boot.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Negative controls:** none of C-D1…C-D11 are owned here. Step 3 is the regression guard, and Step 5 protects the developer's data.

**Acceptance criteria:**
- `app` and `migrate` services present with explicit `target:` and `depends_on: service_healthy`.
- `docker compose config` parses.
- The full local sequence yields `/health/live` 200, `/health` 200, `/api/docs` 404, and `(healthy)`.
- `postgres` keeps 5432 + volume; `postgres-test` keeps 5433 + tmpfs; no lines removed.
- Only `docker-compose.yml` changed.

**Independent review focus:**
1. Was any existing service altered? `git diff` must show additions only.
2. Does `DATABASE_URL` use the service name `postgres`, not `localhost`? Inside a container `localhost` is the container.
3. Are both `target:` values explicit, so a Dockerfile reorder cannot change what compose builds?
4. Is `migrate` a one-shot (`restart: 'no'`, run via `compose run`), never a long-running service?
5. Do any real secrets appear? Defaults must be obviously fake and overridable.
6. Does any instruction use `docker compose down -v`? That destroys the dev database.

---

## Task 6: CI container smoke test and artifact negative controls

**Objective:** run the real image in CI and assert that it starts, migrates, serves, reports healthy, refuses unsafe production configuration, and stops cleanly. The centre of gravity of the phase. Closes G1, G2, G6 and the second `Owner: Phase 6` deferred entry.

**Files:**
- Modify: `.github/workflows/ci.yml` (the `docker` job at :96-107)

**Interfaces:**
- Consumes: `/health/live` (T1), `TRUST_PROXY_HOPS` and the production requirement (T2), the CORS guard + Swagger gate (T3), both build targets + `HEALTHCHECK` (T4).
- Produces: the measured evidence T7 reports.

**Dependencies:** **T1, T2, T3 and T4 must all be complete with their gates passing.** Do not begin before then — the job asserts behaviour that would not yet exist, and a failing smoke job is indistinguishable from a broken one.

**Spec sections:** §10 (all), §12, §13, §17.3 (C-D5…C-D11), §19.1 R1–R2. **DoD:** 4, 5, 6, 7, 8, 10, 11, 12, 13, 21.

### The network decision, and why it is not a service container

Every other database-using job in `ci.yml` uses a GitHub Actions **service container**, reachable from the job on `localhost`. That does not work here: the application under test is itself a `docker run` container on the default bridge, and a service container is not reachable from there by `localhost`.

**Run Postgres as a plain container on a user-defined Docker network**, and attach the `migrate` and `runtime` containers to the same network. They address Postgres by container name and nothing depends on the runner's `localhost`.

This also delivers the only network isolation the phase verifies: on a user-defined network Postgres needs **no published port at all**, so the smoke run genuinely demonstrates an app reaching a database unreachable from outside the network. **Comment this in the workflow**, or a future maintainer will "fix" it back into a service container and break the networking.

### The production-environment consequence

The smoke run uses `NODE_ENV=production`, because those are the guards being proven. Joi then **forbids `PAYMENT_PROVIDER=fake`**, so the run is forced onto the Stripe adapter, which requires `PAYMENT_API_KEY`.

Verified: `StripePaymentProvider`'s constructor reads the webhook secret and the key, **throws if the key is empty or undefined**, and makes **no network call**. A syntactically plausible dummy key is enough to boot, and no endpoint this test touches reaches the provider.

Mandatory consequences:
- Set `PAYMENT_PROVIDER=stripe` and an obviously fake `PAYMENT_API_KEY`.
- `PAYMENT_WEBHOOK_SECRET` must be ≥ 16 characters (Joi floor).
- **Touch no route that calls the provider** — no payment initiation, no webhook.
- **Do not assert the absence of error-level logs.** Maintenance jobs are enabled by default, and the reconciliation sweep (`0 */15 * * * *`) or expiry sweep (`0 */5 * * * *`) may tick during the window and fail against the dummy key. That is harmless — the scheduler catches, the runner's `finally` releases the lease, the next tick retries — but an "no errors" assertion would be flaky for exactly that reason. Assert what is positively expected instead.

---

- [ ] **Step 1: Replace the `docker` job's body**

In `.github/workflows/ci.yml`, replace the job at :96-107. Keep the job key `docker` so no branch protection rule needs changing.

```yaml
  docker:
    name: Docker image runs and serves
    runs-on: ubuntu-latest

    # Phase 6. This job used to run `docker build` and stop, which proved only
    # that the Dockerfile parses -- not that the container starts, connects and
    # serves. It now runs the real artifact.
    #
    # NOTE ON THE DATABASE, AND PLEASE DO NOT "FIX" IT BACK: every other
    # database job here uses a GitHub Actions `services:` container, reached on
    # localhost. That cannot work for this job, because the app under test is
    # itself a `docker run` container on its own network, and a service
    # container is not reachable from there by localhost. So Postgres runs as a
    # plain container on a user-defined network and is addressed BY NAME.
    #
    # A bonus that is the only network boundary this phase actually verifies:
    # on a user-defined network Postgres needs no published port at all, so the
    # app reaches a database that is unreachable from outside the network.
    env:
      IMAGE: ecommerce-backend
      NETWORK: phase6-smoke
      PGHOST_CONTAINER: smoke-postgres
      DB_URL: postgresql://postgres:postgres@smoke-postgres:5432/ecommerce_smoke
      # Required under NODE_ENV=production. `fake` is rejected there, which
      # forces the Stripe adapter -- whose constructor needs a non-empty key
      # but makes NO network call, so an obviously fake key boots fine. No
      # endpoint asserted below reaches the provider.
      SMOKE_JWT_SECRET: ci-only-secret-not-used-outside-continuous-integration
      SMOKE_API_KEY: sk_test_ci_only_not_a_real_key
      SMOKE_WEBHOOK_SECRET: ci-only-webhook-secret-not-used-outside-ci
      SMOKE_CORS_ORIGIN: https://ci.example.test
      SMOKE_TRUST_PROXY_HOPS: '1'

    steps:
      - uses: actions/checkout@v5

      # Two --target invocations, one Dockerfile, one commit, one build
      # context. Deliberately NOT buildx or Bake: adding a tool just to make a
      # single command emit two tags would be a dependency bought with a
      # phrase. The shared `build` stage is built once and cached for the
      # second invocation.
      - name: Build the runtime image
        run: docker build --target runtime -t "$IMAGE:smoke-runtime" .

      - name: Build the migration image
        run: docker build --target migrate -t "$IMAGE:smoke-migrate" .

      # Guards the Dockerfile stage order: `runtime` must stay last, so a bare
      # `docker build` keeps producing the server and not the migrator.
      - name: Assert the default build target is still the server
        run: |
          set -euo pipefail
          docker build -t "$IMAGE:smoke-default" .
          CMD_JSON=$(docker inspect -f '{{json .Config.Cmd}}' "$IMAGE:smoke-default")
          echo "default CMD: $CMD_JSON"
          test "$CMD_JSON" = '["node","dist/main"]'

      - name: Create the smoke network and start Postgres
        run: |
          set -euo pipefail
          docker network create "$NETWORK"
          # No -p: nothing outside this network can reach the database.
          docker run -d --name "$PGHOST_CONTAINER" --network "$NETWORK" \
            -e POSTGRES_USER=postgres \
            -e POSTGRES_PASSWORD=postgres \
            -e POSTGRES_DB=ecommerce_smoke \
            --health-cmd 'pg_isready -U postgres' \
            --health-interval 5s --health-timeout 5s --health-retries 10 \
            postgres:16-alpine
          for i in $(seq 1 30); do
            STATUS=$(docker inspect -f '{{.State.Health.Status}}' "$PGHOST_CONTAINER")
            [ "$STATUS" = healthy ] && break
            sleep 2
          done
          test "$(docker inspect -f '{{.State.Health.Status}}' "$PGHOST_CONTAINER")" = healthy
```

- [ ] **Step 2: Add the migration step — DoD 6**

```yaml
      - name: Run migrations from the migration image
        run: |
          set -euo pipefail
          docker run --rm --network "$NETWORK" -e DATABASE_URL="$DB_URL" \
            "$IMAGE:smoke-migrate"
          # All five committed migrations must be recorded as applied.
          APPLIED=$(docker exec "$PGHOST_CONTAINER" psql -U postgres -d ecommerce_smoke -tAc \
            "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;")
          echo "applied migrations: $APPLIED"
          test "$APPLIED" = "5"
```

- [ ] **Step 3: Add the three boot-abort controls — C-D5, C-D6, C-D7**

These must come **before** the long-running container starts, so a failure is cheap and unambiguous.

```yaml
      # C-D5, C-D6, C-D7. Each proves that a guard already unit-tested ALSO
      # holds in the artifact that ships. That gap -- schema proven, image
      # unproven -- is the whole reason this job exists.
      #
      # Each asserts a NON-ZERO exit AND the offending variable named in the
      # output. Exit-code-only checking would pass against a container that
      # died for an unrelated reason.
      - name: C-D5 - the image refuses the fake payment provider in production
        run: |
          set -euo pipefail
          set +e
          OUT=$(docker run --rm --network "$NETWORK" \
            -e DATABASE_URL="$DB_URL" -e JWT_SECRET="$SMOKE_JWT_SECRET" \
            -e PAYMENT_PROVIDER=fake \
            -e PAYMENT_WEBHOOK_SECRET="$SMOKE_WEBHOOK_SECRET" \
            -e CORS_ORIGIN="$SMOKE_CORS_ORIGIN" \
            -e TRUST_PROXY_HOPS="$SMOKE_TRUST_PROXY_HOPS" \
            "$IMAGE:smoke-runtime" 2>&1)
          CODE=$?
          set -e
          echo "$OUT"
          test "$CODE" -ne 0
          echo "$OUT" | grep -q 'PAYMENT_PROVIDER'

      - name: C-D6 - the image refuses to boot without TRUST_PROXY_HOPS
        run: |
          set -euo pipefail
          set +e
          OUT=$(docker run --rm --network "$NETWORK" \
            -e DATABASE_URL="$DB_URL" -e JWT_SECRET="$SMOKE_JWT_SECRET" \
            -e PAYMENT_PROVIDER=stripe -e PAYMENT_API_KEY="$SMOKE_API_KEY" \
            -e PAYMENT_WEBHOOK_SECRET="$SMOKE_WEBHOOK_SECRET" \
            -e CORS_ORIGIN="$SMOKE_CORS_ORIGIN" \
            "$IMAGE:smoke-runtime" 2>&1)
          CODE=$?
          set -e
          echo "$OUT"
          test "$CODE" -ne 0
          echo "$OUT" | grep -q 'TRUST_PROXY_HOPS'

      - name: C-D7 - the image refuses a wildcard CORS origin in production
        run: |
          set -euo pipefail
          set +e
          OUT=$(docker run --rm --network "$NETWORK" \
            -e DATABASE_URL="$DB_URL" -e JWT_SECRET="$SMOKE_JWT_SECRET" \
            -e PAYMENT_PROVIDER=stripe -e PAYMENT_API_KEY="$SMOKE_API_KEY" \
            -e PAYMENT_WEBHOOK_SECRET="$SMOKE_WEBHOOK_SECRET" \
            -e CORS_ORIGIN='*' \
            -e TRUST_PROXY_HOPS="$SMOKE_TRUST_PROXY_HOPS" \
            "$IMAGE:smoke-runtime" 2>&1)
          CODE=$?
          set -e
          echo "$OUT"
          test "$CODE" -ne 0
          echo "$OUT" | grep -q 'CORS_ORIGIN'
```

- [ ] **Step 4: Start the server and verify both halves of health — DoD 4, C-D11**

```yaml
      - name: Start the runtime container
        run: |
          set -euo pipefail
          docker run -d --name smoke-app --network "$NETWORK" -p 3000:3000 \
            -e DATABASE_URL="$DB_URL" -e JWT_SECRET="$SMOKE_JWT_SECRET" \
            -e PAYMENT_PROVIDER=stripe -e PAYMENT_API_KEY="$SMOKE_API_KEY" \
            -e PAYMENT_WEBHOOK_SECRET="$SMOKE_WEBHOOK_SECRET" \
            -e CORS_ORIGIN="$SMOKE_CORS_ORIGIN" \
            -e TRUST_PROXY_HOPS="$SMOKE_TRUST_PROXY_HOPS" \
            "$IMAGE:smoke-runtime"

      # Bounded polling, never a fixed sleep: a sleep either flakes when the
      # boot is slow or wastes time when it is fast. A timeout here is a
      # FAILURE, not a skip.
      - name: Wait for the endpoint to serve
        run: |
          set -euo pipefail
          for i in $(seq 1 45); do
            if curl -fsS http://127.0.0.1:3000/health/live >/dev/null 2>&1; then
              echo "serving after ${i} attempt(s)"
              exit 0
            fi
            sleep 2
          done
          echo "::error::/health/live never served"
          exit 1

      # C-D11. Docker's OWN health state, not an inference from the step above.
      #
      # The two prove different things and either can pass while the other
      # fails: polling the endpoint proves the ENDPOINT serves; polling this
      # proves the CHECK works. A HEALTHCHECK whose command is missing from the
      # image reports `unhealthy` rather than erroring, so nothing in the
      # application log would name the cause.
      #
      # Ceiling accommodates start-period (15s) + interval (10s) x retries (3)
      # with margin.
      - name: C-D11 - Docker reports the container healthy
        run: |
          set -euo pipefail
          for i in $(seq 1 40); do
            STATUS=$(docker inspect -f '{{.State.Health.Status}}' smoke-app)
            echo "attempt ${i}: ${STATUS}"
            if [ "$STATUS" = healthy ]; then exit 0; fi
            if [ "$STATUS" = unhealthy ]; then
              echo "::error::container reported unhealthy"
              docker inspect -f '{{json .State.Health}}' smoke-app
              exit 1
            fi
            sleep 3
          done
          echo "::error::health status never reached healthy (timeout is a failure)"
          docker inspect -f '{{json .State.Health}}' smoke-app
          exit 1

      # C-D11, the other two halves. A green status alone does not prove the
      # configured command can run, nor that it targets the right endpoint --
      # a check pointed at /health would report healthy while carrying exactly
      # the defect the liveness split exists to prevent.
      - name: C-D11 - the configured command runs in the image and targets /health/live
        run: |
          set -euo pipefail
          HC=$(docker inspect -f '{{json .Config.Healthcheck}}' "$IMAGE:smoke-runtime")
          echo "configured healthcheck: $HC"
          echo "$HC" | grep -q '/health/live'
          echo "$HC" | grep -vq '"/health"'
          # Execute it where Docker executes it.
          docker exec smoke-app wget --quiet --tries=1 --spider \
            http://127.0.0.1:3000/health/live
          docker exec smoke-app sh -c 'command -v wget'
```

- [ ] **Step 5: Add the positive assertions — DoD 4, 5**

```yaml
      - name: Readiness and routing probes
        run: |
          set -euo pipefail
          # /health proves Prisma connected to a real database from inside the
          # container.
          curl -fsS http://127.0.0.1:3000/health | tee /tmp/health.json
          grep -q '"status":"ok"' /tmp/health.json

          curl -fsS http://127.0.0.1:3000/health/live | tee /tmp/live.json
          grep -q '"status":"ok"' /tmp/live.json

          # One request exercising the global prefix, URI versioning, the
          # @Public() path through three global guards, a real query and DTO
          # mapping. Chosen because it is public and correct on an EMPTY
          # database, so it needs no seeding.
          curl -fsS http://127.0.0.1:3000/api/v1/products | tee /tmp/products.json
          grep -q '"data":\[\]' /tmp/products.json
          grep -q '"meta"' /tmp/products.json

      # C-D8. A unit test proves the branch; only this proves the route is
      # absent from the shipped artifact.
      - name: C-D8 - the API docs are not published in production
        run: |
          set -euo pipefail
          CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/docs)
          echo "GET /api/docs -> $CODE"
          test "$CODE" = "404"

      # DoD 5. Proves ConfigService -> SchedulerRegistry wiring inside the real
      # image; today that path is covered only by unit tests, and a deployment
      # whose cron silently never registered would look healthy on every probe.
      #
      # Deliberately NOT asserting the absence of error logs: a sweep may tick
      # during this window and fail against the dummy provider key, which is
      # harmless but would make such an assertion flaky.
      - name: Maintenance cron registered inside the image
        run: |
          set -euo pipefail
          docker logs smoke-app > /tmp/app.log 2>&1
          grep -q 'Scheduled order-expiry' /tmp/app.log
          grep -q 'Scheduled maintenance-purge' /tmp/app.log
          grep -q 'Scheduled payment-reconciliation' /tmp/app.log
```

**Note on job names:** the three `Scheduled …` strings must match `MaintenanceJobName`'s actual enum values. Read `src/modules/maintenance/maintenance-job-name.enum.ts` and use the exact values; if they differ from the above, use the real ones.

- [ ] **Step 6: Add the readiness/liveness divergence assertion — C-D3 container half, DoD 8**

```yaml
      # C-D3, container half, and the strongest available evidence for the
      # liveness split: liveness does not depend on the database, readiness
      # does, and Prisma reconnects without a restart.
      #
      # This is the highest-flake-risk assertion in the phase, so every wait is
      # bounded polling with a generous ceiling. If it proves genuinely
      # unstable it may be downgraded to the unit-level equivalent in
      # health.controller.spec.ts -- but ONLY as the spec authorises, WITH the
      # downgrade and its evidence recorded in the closeout. It is never
      # quietly deleted.
      - name: C-D3 - liveness survives a database outage, readiness does not
        run: |
          set -euo pipefail
          docker stop "$PGHOST_CONTAINER"

          # Liveness must stay 200 with no database at all.
          curl -fsS http://127.0.0.1:3000/health/live >/dev/null
          echo 'liveness still 200 with the database down'

          # Readiness must become 503, polled because the pool may need a
          # moment to notice.
          for i in $(seq 1 20); do
            CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
            echo "attempt ${i}: /health -> ${CODE}"
            [ "$CODE" = "503" ] && break
            sleep 2
          done
          test "$CODE" = "503"

          # And liveness is STILL fine at the moment readiness is failing --
          # the assertion that actually names the property.
          curl -fsS http://127.0.0.1:3000/health/live >/dev/null

          docker start "$PGHOST_CONTAINER"
          for i in $(seq 1 40); do
            CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health)
            echo "recovery attempt ${i}: /health -> ${CODE}"
            [ "$CODE" = "200" ] && break
            sleep 3
          done
          test "$CODE" = "200"
          echo 'readiness recovered without a restart'
```

- [ ] **Step 7: Add the shutdown control — C-D9, DoD 7**

```yaml
      # C-D9. Exit 0 is the assertion that carries the content. `docker stop`
      # sends SIGTERM, waits, then SIGKILLs -- so a container that IGNORED
      # SIGTERM would still "stop", with exit code 137. Asserting merely that
      # it stopped would pass against a process with no handler at all.
      - name: C-D9 - SIGTERM is handled, exit 0 within 10s
        run: |
          set -euo pipefail
          START=$(date +%s)
          docker stop --timeout 10 smoke-app
          ELAPSED=$(( $(date +%s) - START ))
          CODE=$(docker inspect -f '{{.State.ExitCode}}' smoke-app)
          echo "exit=${CODE} elapsed=${ELAPSED}s"
          test "$CODE" = "0"
          test "$ELAPSED" -lt 10
```

- [ ] **Step 8: Add failure-log collection**

```yaml
      # A smoke test that fails without logs is a smoke test nobody can fix,
      # and this job is the one place in CI where the failure is three layers
      # away from the assertion. `if: failure()` so it runs on any failing step
      # above, including a health status that never reached healthy.
      - name: Collect diagnostics on failure
        if: failure()
        run: |
          echo '===== app logs ====='
          docker logs smoke-app 2>&1 || echo '(no app container)'
          echo '===== app health state ====='
          docker inspect -f '{{json .State.Health}}' smoke-app 2>&1 || echo '(none)'
          echo '===== app exit code ====='
          docker inspect -f '{{.State.ExitCode}}' smoke-app 2>&1 || echo '(none)'
          echo '===== postgres logs ====='
          docker logs "$PGHOST_CONTAINER" 2>&1 || echo '(no postgres container)'
          echo '===== containers ====='
          docker ps -a
          echo '===== configured healthcheck ====='
          docker inspect -f '{{json .Config.Healthcheck}}' "$IMAGE:smoke-runtime" 2>&1 || echo '(none)'

      - name: Tear down
        if: always()
        run: |
          docker rm -f smoke-app "$PGHOST_CONTAINER" 2>/dev/null || true
          docker network rm "$NETWORK" 2>/dev/null || true
```

- [ ] **Step 9: Validate the workflow locally before pushing**

```bash
python -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml')); print('jobs:', list(d['jobs'])); print('docker steps:', len(d['jobs']['docker']['steps']))"
```

Expected: the five original jobs still listed (`build`, `e2e`, `docker`, `bootstrap`) with `docker` carrying the new steps. **Confirm no other job changed:**

```bash
git diff .github/workflows/ci.yml | grep '^-' | grep -v '^---'
```

Expected: removed lines confined to the old `docker` job.

- [ ] **Step 10: Run the smoke sequence locally, end to end**

Execute Steps 1–8's shell bodies by hand on the local machine, in order, with the same env values. This is the cheapest way to find R1 (the networking) without burning CI round-trips. Every assertion must pass locally before the branch is pushed.

- [ ] **Step 11: Mutation-verify the artifact controls**

Each mutation is made, the smoke sequence re-run locally, the failing assertion recorded, then reverted:

| Mutation | Control | Must fail on |
|---|---|---|
| Add `Joi.override` removal — allow `fake` in production | C-D5 | the `grep -q 'PAYMENT_PROVIDER'` / non-zero-exit assertion |
| Give `TRUST_PROXY_HOPS` a production default | C-D6 | the `grep -q 'TRUST_PROXY_HOPS'` assertion |
| Drop `.invalid('*')` from `CORS_ORIGIN` | C-D7 | the `grep -q 'CORS_ORIGIN'` assertion |
| Remove the Swagger gate | C-D8 | `test "$CODE" = "404"` |
| Point `HEALTHCHECK` at `/health` | C-D11 | the `grep -q '/health/live'` **endpoint** assertion, while the *status* assertion still passes |
| `HEALTHCHECK` uses `curl` | C-D11 | the status poll → `unhealthy`, and `docker exec … command -v wget` |
| Remove `app.enableShutdownHooks()` from `configureApp()` | C-D9 | `test "$CODE" = "0"` (exit becomes 137) |
| Make `live()` query the database | C-D3 | `curl -fsS …/health/live` **while Postgres is stopped** |
| Move the `migrate` stage after `runtime` | stage order | `test "$CMD_JSON" = '["node","dist/main"]'` |

**Revert every mutation and re-run to confirm a fully green sequence.** Record each one.

- [ ] **Step 12: Full gates, then push and read CI**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Then push the branch and read the actual CI result. **All five jobs must pass.** If the smoke job fails on networking, that is R1 — fix the network wiring, do not convert it to a service container.

- [ ] **Step 13: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: run the image instead of only building it

The docker job proved the Dockerfile parses. It now runs the artifact: builds
both targets, migrates a throwaway database, serves, reports healthy, and stops
with exit 0.

Seven controls that unit tests structurally cannot cover, because each asks
whether a guard holds in the IMAGE rather than in the schema: three production
boot-aborts, the docs not being published, Docker's own health status plus the
check's command and endpoint, SIGTERM handling, and liveness surviving a
database outage that readiness correctly fails.

Postgres runs as a plain container on a user-defined network, not a services:
container -- a service container is not reachable from another container by
localhost. It publishes no port, which is the one network boundary this phase
verifies rather than documents.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Negative controls:** C-D3 (container half), C-D5, C-D6, C-D7, C-D8, C-D9, C-D11 (all three halves) — nine mutations in Step 11.

**Acceptance criteria:**
- The `docker` job builds both targets with two `--target` invocations; no buildx, no Bake, no registry login, no push.
- Default-target guard passes (`["node","dist/main"]`).
- Five migrations applied from the migration image; `_prisma_migrations` count asserted.
- `/health/live`, `/health`, `/api/v1/products` all assert on **body content**, not just status.
- Three `Scheduled …` log lines asserted; **no** "absence of errors" assertion anywhere.
- `/api/docs` → 404.
- Docker health status reaches `healthy` under bounded polling; the check's command executes in-image; the endpoint is asserted to be `/health/live` and asserted **not** to be `/health`.
- `docker stop` → exit 0 in < 10s.
- C-D3's outage/recovery sequence passes with bounded polling only, no fixed sleeps as waits.
- Diagnostics collected via `if: failure()`; teardown via `if: always()`.
- All five CI jobs green on the pushed branch.

**Independent review focus:**
1. Does any wait use a bare `sleep` as its *mechanism* rather than as a poll interval? A timeout must be a failure, never a silent skip.
2. Does C-D11 read **Docker's** `.State.Health.Status`, or does it re-implement the check with `curl`? Re-implementing proves nothing about the configured check.
3. Is the endpoint asserted separately from the status? A check on `/health` reports healthy while carrying the crash-loop defect.
4. Do the boot-abort controls assert the **named variable** in the output, or only a non-zero exit? Exit-code-only passes against an unrelated crash.
5. Is there any assertion on the absence of error logs? It must not exist — a sweep may tick against the dummy key.
6. Is Postgres on a user-defined network with **no published port**, and is the reason commented so it is not "fixed" back?
7. Any registry login, `docker push`, or tag publish? D10 forbids all three.
8. Were all nine Step 11 mutations actually run, with each failure landing on the property-naming assertion?
9. Did any other CI job change? Only `docker` should differ.

---

## Task 7: Documentation and measured closeout

**Objective:** record what shipped, with numbers that were measured rather than expected, and close the deferred-limitations entries by shipping — never by deleting.

**Files:**
- Modify: `README.md` (status block at :21-41; env tables; a new release runbook section)
- Modify: `docs/deferred-limitations.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the measured output of T1–T6.
- Produces: nothing consumed by code.

**Dependencies:** **T1–T6 all complete with green gates.** T7 reports measurements, and writing it earlier means writing numbers that are not yet true.

**Spec sections:** §19.3, §20. **DoD:** 25, 26, 27, 28, 29, 30, 31.

---

- [ ] **Step 1: Measure everything, fresh, and write the numbers down**

```bash
docker compose up -d postgres-test
npm run lint:ci
npm run build
npm test 2>&1 | tail -5
npm run test:e2e 2>&1 | tail -5
```

Record the **actual** suite and test counts from this run. The Phase 5 baseline was unit 33/430 and e2e 28/337; the real Phase 6 numbers are higher and must come from this output. **Do not reprint the baseline as if measured.**

Also record: the OpenAPI inventory count (21 → likely 22 with `/health/live`), the CI run URL with all five jobs green, and for each of C-D1…C-D11 the mutation applied and the assertion that failed.

- [ ] **Step 2: Update the README status block**

`README.md:23` — change the current-phase line, and replace the Phase 6 bullet at :32:

```markdown
- ✅ Deployment: a CI job that runs the real image — migrate, serve, report healthy, stop clean — plus a liveness probe, a required trusted-proxy hop count, production config guards, and a migration image built from the same Dockerfile and commit
```

- [ ] **Step 3: Add the environment variables to the README's config table**

```markdown
| `TRUST_PROXY_HOPS` | **required under `NODE_ENV=production`**, no default; `0` elsewhere | The number of reverse proxies that will **append** to `X-Forwarded-For`. Governs `req.ip` and therefore every rate-limit bucket. Set it to match **your** topology: `0` direct-to-Node, `1` one reverse proxy, `2` a CDN in front of a load balancer. **There is no universally correct value.** Too low collapses every client into one bucket (the 5/min login limit becomes 5/min for the whole internet); **too high is worse and silent** — Express counts past the proxy-appended entries into attacker-supplied ones and the limit is bypassed |
| `CORS_ORIGIN` | `*` outside production; **required and `*`-rejected under production** | The exact origin permitted to call this API |
```

**DoD 15c:** this table must not present `1` as universal or recommended. Where `1` appears, it is labelled as one option among `0` and `2`, and as the reference topology the tests use.

- [ ] **Step 4: Add the release runbook**

A new README section:

```markdown
### Release

Migrations are a **discrete release command** and never run at application boot.
The migrator and the server are two `--target` builds of one Dockerfile at one
commit, which is what stops a migration being applied from a different checkout
than the running image.

```bash
# 1. Build both targets from the same commit
docker build --target migrate -t ecommerce-backend:migrate .
docker build --target runtime -t ecommerce-backend:runtime .

# 2. Apply migrations. This MUST exit 0 before step 3.
docker run --rm -e DATABASE_URL="$DATABASE_URL" ecommerce-backend:migrate

# 3. Serve
docker run -d -p 3000:3000 \
  -e DATABASE_URL="$DATABASE_URL" \
  -e JWT_SECRET="$JWT_SECRET" \
  -e PAYMENT_PROVIDER=stripe -e PAYMENT_API_KEY="$PAYMENT_API_KEY" \
  -e PAYMENT_WEBHOOK_SECRET="$PAYMENT_WEBHOOK_SECRET" \
  -e CORS_ORIGIN="https://your-origin.example" \
  -e TRUST_PROXY_HOPS=<the number of proxies in YOUR chain> \
  ecommerce-backend:runtime
```

Locally, `docker compose run --rm migrate` then `docker compose up -d app`.

**Probes.** Point container liveness and `HEALTHCHECK` at **`/health/live`** — process
only, no database. Point a readiness probe at **`/health`**, which queries the
database and 503s when it is unreachable. **Do not point liveness at `/health`:**
`PrismaService` exits the process when it cannot connect, so a restart cannot
succeed while the database is down, and the restart prevents the reconnection
that would otherwise have happened on its own.

**Shutdown.** `SIGTERM` is handled and the process exits 0; CI asserts that within
10s on an idle container. Two caveats: in-flight HTTP requests are not proven to
drain under load, and a container stopped **mid-sweep** may be killed before the
maintenance runner's `finally` releases its lease, which then stays held until it
lapses — up to `MAINTENANCE_LEASE_SECONDS` (default 300s), during which that job
reports `skipped: lease-held`. This is safe: a lapsed lease is exactly the
recovery path designed for a crashed holder.

**Time.** The image pins `TZ=UTC`, so `MAINTENANCE_PURGE_CRON=0 0 3 * * *` means
03:00 UTC.

**The database must not be reachable from the internet.** Development compose
publishes `5432` for convenience, which is correct for development and not a
deployment template.
```

- [ ] **Step 5: Close the two `Owner: Phase 6` deferred entries — by shipping**

In `docs/deferred-limitations.md`, follow the file's existing convention exactly: strike the heading, mark it closed, and **preserve the original reasoning text**. Never delete an entry.

For *"Rate limiting keys on `req.ip`, with no trusted-proxy configuration"*:

```markdown
### ~~Rate limiting keys on `req.ip`, with no trusted-proxy configuration~~ — CLOSED by Phase 6

**Closed by shipping, not by deletion.** `TRUST_PROXY_HOPS` sets Express's
`trust proxy` in `configureApp()`, and `ThrottlerGuard.getTracker()` returns
`req.ip`, so that one setting governs every bucket — no custom tracker.

It is a **numeric hop count, never `true`**: `true` takes the leftmost
`X-Forwarded-For` entry, which is attacker-supplied, and would make the 5/min
login limit unlimited. A number counts from the right, skipping exactly the
proxy-appended entries.

**Required under `NODE_ENV=production` with no default**, because neither
default is safe — `0` behind a proxy collapses every client into one bucket,
and a value above the real chain depth is a silent bypass. The deployer states
the topology, which is what the original entry asked for.

**One hop is the reference topology for the tests, not a universal value.** It
must be set per deployment to the number of proxies that will append to
`X-Forwarded-For`, and **too high is the dangerous direction** — too low
degrades availability loudly, too high removes the control silently.

Controls C-D1 and C-D2 are recorded failing against `trust proxy: true` and
against no setting at all, respectively.
```

For *"The runtime image's Prisma setup is undeclared and untested"* — **closed only in part**, and the entry must say which part:

```markdown
### The runtime image's Prisma setup is undeclared and untested — PARTLY CLOSED by Phase 6

**Closed by shipping:** CI now **runs** the image rather than only building it —
it migrates a throwaway database from a `migrate` image, serves, reports healthy
through Docker's own health state, and stops with exit 0. The migration path
ships as an artifact built from the same Dockerfile and commit as the server, so
a migration can no longer be applied from a different checkout than the running
image. The serving image carries no Prisma migration CLI **and no schema
engine** — and the entry must say that this took an **explicit prune**, because
`npm ci --omit=dev` alone did not achieve it: `prisma` is an optional peer of the
production `@prisma/client`, so it shipped as `devOptional` (spec §9.2.1, T4a).
Record the generalisable lesson, not just the fix: a `devDependencies`
declaration is not an absence guarantee when a production dependency
peer-depends on the same package.

**Precisely what that last point does and does not establish:** it is a
**tooling boundary, not a capability boundary**. The standard Prisma migration
CLI and the schema engine are absent, so `prisma migrate deploy` cannot be
invoked there. It does
**not** prove schema mutation is impossible — `PrismaService` extends
`PrismaClient`, which exposes `$executeRaw` and `$executeRawUnsafe`, and the
database role is whatever `DATABASE_URL` supplies. No DDL exists in `src/`
today (the only raw SQL is the health check's `SELECT 1`), so it is a latent
capability rather than an exercised one. Closing it would need a
least-privilege application role distinct from the migration role — a database
administration decision, out of scope for Phase 6.

**Still open:** the runtime stage copies the generated client via
`node_modules/.prisma`, a layout Prisma does not contract. **Owner:
unscheduled. Trigger: a Prisma major upgrade.**
```

- [ ] **Step 6: Sharpen the throttler-storage entry — a number and a named decision**

```markdown
**Phase 6 amendment — the trigger, with numbers.** Redis-backed throttler
storage stays deferred because Phase 6's topology is a **single instance**,
where in-memory storage is *correct* rather than a compromise.

What changes with more than one: with `N` replicas and in-memory storage the
effective limit is **`N × limit` per client**, and buckets do not share, so the
login control degrades from 5/minute to **5N/minute** — weakened, not
eliminated.

**The trigger is a second replica, not a date.** And whoever adds Redis must
decide, explicitly and in writing, between **fail-open** (storage unreachable →
rate limiting silently disappears, exactly when infrastructure is degraded and
probing is most likely) and **fail-closed** (a cache outage becomes a total API
outage). Neither is right in general. That choice is the work, not the wiring.
```

- [ ] **Step 7: Add the six new deferred entries**

Add, in the file's established voice: (1) shutdown drains neither in-flight requests nor in-flight sweeps, with the lease-held bound; (2) liveness and readiness have different semantics and the probe assignment must be honoured; (3) the scheduler registers crons in `onModuleInit`, before `app.listen()`, so a tick can fire while the port is still binding; (4) no request logging exists, so `TRUST_PROXY_HOPS` is verifiable only through throttling behaviour and a misconfigured hop count has no direct log signal; (5) the migration-tooling boundary of Step 5, cross-referenced; **(6) the runtime image still carries the migration SQL it cannot apply** — `COPY prisma ./prisma` puts `schema.prisma` and all five migration directories into the serving image, which is *data, not tooling* (nothing in the pruned image can execute them), but the schema and its history are readable from a serving container. Spec §19.3 item 9; **trigger:** a measured need to shrink the image, or a threat model that objects to the schema being readable.

**Six, not five** — §19.3 gained item 9 with the §9.2 amendment, and DoD 26 now reads "entries 4–9". An executor who writes five satisfies the old count and silently drops item 9.

- [ ] **Step 8: Add the `CLAUDE.md` Phase 6 section**

A new section after Phase 5's, recording only the non-obvious rules a future session would otherwise rediscover:

```markdown
### Deployment (Phase 6 — implemented)

- **`TRUST_PROXY_HOPS` is per-deployment and has no production default, and
  "too high" is the dangerous direction.** `ThrottlerGuard.getTracker()` returns
  bare `req.ip`, so Express's `trust proxy` is the only lever on bucketing — no
  custom tracker, and **never `trust proxy: true`**, which takes the leftmost
  attacker-supplied `X-Forwarded-For` entry and makes the 5/min login limit
  unlimited. A numeric count works from the right. Too low collapses every
  client into one bucket (loud); too high bypasses the limit (silent). `1` is
  the tests' reference topology and must never become a default, a fallback, or
  a README recommendation — but a test setting `1` is correct, not a violation.
- **Liveness must never touch the database.** `/health/live` is synchronous and
  does no I/O; `/health` keeps its `SELECT 1`. `PrismaService.onModuleInit()`
  exits the process when `$connect()` fails, so a liveness probe on `/health`
  turns a transient outage into an unbootable crash loop and prevents the
  reconnection that would have happened on its own. **`/health` stays throttled
  and `/health/live` does not** — `/health` costs a database round trip and is
  public, so un-throttling it builds an unauthenticated load amplifier;
  `/health/live` costs nothing. Do not skip the throttle on both.
- **The global-prefix exclude list needs one entry per route path.** A route is
  matched by its full path, so `health` does not cover `health/live`. Both
  entries are in `configureApp()`, and the test that catches a regression is
  the `/api/health/live` 404 — not the `/health/live` 200.
- **The serving image deliberately carries no Prisma migration CLI and no schema
  engine, and it takes an explicit `rm -rf` chained into `npm ci --omit=dev` to
  keep it that way.** `--omit=dev` does **not** achieve this: `prisma` is an
  optional *peer* dependency of the production `@prisma/client`, so the lockfile
  marks it `devOptional` and `--omit=dev` keeps it — measured at 6.19.3 inside
  the built image before the prune existed. **Generalise it: a `devDependencies`
  declaration is not an absence guarantee when a production dependency
  peer-depends on the same package.** Do not "simplify" that `RUN` back to a
  bare `npm ci --omit=dev`, and do not split the `rm -rf` into its own `RUN` — a
  separate layer leaves the bytes in the image while every absence check still
  passes. `@prisma/engines` goes too (it holds the schema engine plus a
  *duplicate* query engine); the generated client loads its own copy from
  `node_modules/.prisma/client/`, which must never be added to that list.
  This is a **tooling** boundary, not a capability one: it does not make schema
  mutation impossible (`$executeRaw` still exists, and the database role is
  whatever `DATABASE_URL` supplies). Do not overclaim it. The `migrate` stage
  sits **before** `runtime` in the Dockerfile because `docker build` with no
  `--target` builds the last stage, and a bare build must keep producing the
  server.
- **A `HEALTHCHECK` in the Dockerfile is not evidence it works.** CI reads
  Docker's own `.State.Health.Status` under bounded polling, executes the
  configured command inside the running container, and asserts the endpoint is
  `/health/live`. A check whose command is missing reports `unhealthy` rather
  than erroring, so it fails silently and looks like an application fault.
- **The smoke job runs Postgres as a plain container on a user-defined network,
  not a `services:` container** — a service container is not reachable from
  another container by `localhost`. Do not "fix" it back.
- **The smoke job must not assert the absence of error logs.** It runs under
  `NODE_ENV=production`, which forbids `PAYMENT_PROVIDER=fake` and so forces the
  Stripe adapter with a dummy key; a maintenance sweep may tick during the
  window and fail against it. Harmless, and fatal to such an assertion.
- **Redis-backed throttling is deferred with a trigger, not pending.** At one
  instance in-memory storage is correct. At `N` replicas the login limit
  degrades to 5N/minute, and adopting Redis requires an explicit fail-open
  versus fail-closed decision.
```

- [ ] **Step 9: Update `CLAUDE.md`'s deferred-limitations summary**

The Important Constraints section lists the accepted gaps. Add Phase 6's new entries and record that Phase 6 **closed one entry by shipping and partly closed another** — matching the convention already used for Phase 5's four closures.

- [ ] **Step 10: Verify every DoD item**

Walk all 31 items of spec §20 against the branch. For each: the evidence, or an honest statement that it was downgraded and why. Items 9–14 need the mutation record from T1–T6; item 30 needs any null/qualified/downgraded result recorded **as such, never upgraded**.

Confirm the scope locks mechanically:

```bash
git diff --stat master..HEAD -- prisma/                     # must be EMPTY (DoD 22)
git diff master..HEAD -- package.json package-lock.json      # must be EMPTY (DoD 23)
git diff --stat master..HEAD -- src/modules/maintenance/ src/modules/payments/   # must be EMPTY
grep -rn 'OrderStatus.PAID' src/ | grep -v spec             # markPaid() only (DoD 24)
git diff --stat master..HEAD                                 # review every file against the plan's file map
```

- [ ] **Step 11: Final gates, measured**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Report the **measured** counts. If any number is lower than the Phase 5 baseline, something regressed — investigate rather than reporting it.

- [ ] **Step 12: Commit**

```bash
git add README.md docs/deferred-limitations.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: record phase 6 deployment, closing two deferred entries by shipping

The trusted-proxy entry closes: a per-deployment hop count, required under
production with no default, with one hop recorded as the tests' reference
topology and "too high" named as the dangerous direction.

The runtime-image entry closes only IN PART, and says which part: CI now runs
the image, the migration path ships as an artifact, and the CLI and schema
engine are pruned from the serving image -- which took an explicit prune,
because --omit=dev kept them as an optional peer of the production client. The
generated client still arrives by a layout Prisma does not contract, and the
prune now depends on that layout. The absent migration tooling is recorded as a
tooling boundary, not a capability boundary -- raw SQL and the database role are
unchanged.

The throttler-storage entry is sharpened rather than closed: N replicas means a
5N/minute login limit, the trigger is a second replica, and adopting Redis
requires an explicit fail-open versus fail-closed decision.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Negative controls:** none owned. T7 **verifies** the records of C-D1…C-D11 and reports honestly.

**Acceptance criteria:**
- `README.md:32` checked off; runbook covers release order, probe assignment, the hop-count rule, shutdown caveats, `TZ=UTC`, and the database boundary.
- The README env table does not present `1` as universal or recommended (DoD 15c).
- Two `Owner: Phase 6` entries closed by shipping with their caveats, one sharpened with the `5N/minute` number and the fail-open/fail-closed requirement, five added. **No entry deleted** (DoD 25).
- `CLAUDE.md` Phase 6 section present; deferred summary updated.
- All 31 DoD items walked, with evidence or an honest downgrade.
- Scope locks verified mechanically: zero migrations, zero dependency changes, no maintenance/payments diff.
- Final gates green with **measured** numbers.

**Independent review focus:**
1. Are the reported counts **measured on this branch**, or the Phase 5 baseline reprinted? The latter is the failure this project treats most seriously.
2. Was any deferred entry **deleted** rather than struck and marked closed? The file's own rule forbids it.
3. Does the runtime-image entry say it is **partly** closed and name the still-open half?
4. Does any document claim schema mutation from a serving container is impossible?
5. Does the README present `1` as a recommended hop count anywhere?
6. Were the C-D1…C-D11 mutations recorded with the specific assertion each failed on?
7. Is any downgraded result — C-D3's container half especially — recorded as downgraded rather than quietly dropped?

---

## DoD coverage — all 31 items

| # | DoD item (spec §20) | Owner | Verified by |
|---|---|---|---|
| 1 | `/health/live` 200, unprefixed, unversioned | T1 | T1 S6, S9, S10 |
| 2 | `/health` unchanged, still throttled | T1 | T1 S9, S14 (no regression) |
| 3 | `/health/live` past the throttle limit (C-D4) | T1 | T1 S11, S12 |
| 4 | Container: live + health + products | T6 | T6 S4, S5 |
| 5 | Container: three `Scheduled …` lines | T6 | T6 S5 |
| 6 | Migrate image applies 5 migrations, exits 0 | T4, T4a, T6 | T4a S9 (fresh DB); T6 S2 |
| 7 | `docker stop` → exit 0 < 10s (C-D9) | T6 | T6 S7 |
| 8 | Postgres stopped → live 200 / health 503 / recovery (C-D3) | T1, T6 | T1 S2, S13 (unit); T6 S6 (container) |
| 9 | C-D1, C-D2 with the vacuity check | T2 | T2 S10, S13, S14 |
| 10 | C-D5, C-D6, C-D7 — three image boot-aborts | T2, T3, T6 | T6 S3 |
| 11 | C-D8 — `/api/docs` not served | T3, T6 | T3 S12; T6 S5 |
| 12 | C-D10 — CLI **and schema engine** absent from `runtime` by explicit prune; `migrate` applies 5 migrations to a fresh DB; pruned `runtime` still serves a DB-backed request | **T4a** | T4a S5–S9, mutations S10–S11 (T4 S8 superseded) |
| 13 | C-D11 — HEALTHCHECK verified at runtime | T4, T6 | T4 S7, S9, S10; T6 S4 |
| 14 | Every mutation recorded | T1–T6 | T1 S12-13, T2 S14, T3 S11-12, T4 S9-10, T6 S11 |
| 15 | `TRUST_PROXY_HOPS` wired, with 15a–15d | T2 | T2 S1, S4, S8, S15 |
| 15a | No production default/fallback of `1` | T2 | T2 S4, S8 |
| 15b | `.env.example` carries `0` | T2 | T2 S15 |
| 15c | README does not present `1` as universal | T7 | T7 S3 |
| 15d | Tests **may** set `1` | T2 | T2 S10 |
| 16 | `CORS_ORIGIN` required, `*`-forbidden in production | T3 | T3 S1, S4, S11 |
| 17 | `TZ=UTC` + `HEALTHCHECK` whose correctness is C-D11 | T3, T4 | T3 S8; T4 S3, S7 |
| 18 | `.dockerignore` excludes docs/test/.superpowers/.claude | T4 | T4 S4, S11 |
| 19 | Boot topology log, leaking no secret | T3 | T3 S7, S13 |
| 20 | Compose `app` + `migrate`; databases untouched | T5 | T5 S1, S3, S4 |
| 21 | CI `docker` job runs the image; network commented | T6 | T6 S1, S9, S12 |
| 22 | **Zero migrations** | all | T7 S10 (`git diff` on `prisma/`) |
| 23 | **Zero new runtime dependencies** | all | T7 S10 (`git diff` on `package.json`) |
| 24 | No new route but `/health/live`; `markPaid()` untouched | all | T7 S10 (grep + diff) |
| 25 | `deferred-limitations.md` closed/sharpened/added, none deleted | T7 | T7 S5, S6, S7 |
| 26 | `README.md:32` + release runbook | T7 | T7 S2, S4 |
| 27 | `CLAUDE.md` Phase 6 section | T7 | T7 S8, S9 |
| 28 | Every per-task gate run and reported | T1–T7 | each task's gate step |
| 29 | Gates green with measured numbers | T7 | T7 S1, S11 |
| 30 | Null/qualified/downgraded results recorded as such | T7 | T7 S10 |
| 31 | No locked decision changed without amending §3 | all | T7 S10; Global Constraints |

**Every item has an owner and a verifier. No requirement is unassigned.**

---

## Contradictions found between the spec and the repository

Reported rather than resolved silently, per the Global Constraints.

**1. T1 and T2 are not independent.** Spec §18 lists T1, T2, and T4 as mutually independent. T4 is. **T1 and T2 are not:** T1 must edit `src/bootstrap.ts:43` to add `health/live` to the global-prefix exclude list, and T2 edits `configureApp()` in that same file. The plan makes T1 → T2 → T3 strictly sequential. The spec's own rule 7 ("keep tasks sequential when they share files") decides it; §18's independence claim is the stale half.

**2. One pre-existing test breaks, by design.** `src/config/env.validation.spec.ts:246` — *"accepts the stripe provider under `NODE_ENV=production` when a key is set"* — asserts `error` is `undefined` while building its environment from `validEnv()`, which supplies neither `TRUST_PROXY_HOPS` nor `CORS_ORIGIN`. Both production guards break it. Repaired in T2 Step 2 via a `validProdEnv()` helper that T3 extends. The neighbouring test at :238 survives untouched, because `abortEarly: false` keeps `PAYMENT_PROVIDER` in the message its `toContain` checks. The spec does not mention this collision.

**3. The spec does not mention the OpenAPI inventory.** `test/swagger.e2e-spec.ts` asserts a hand-maintained endpoint list, currently 21/21. `/health/live` is a new documented endpoint, so that count very likely becomes 22. Handled in T1 Step 14 — update the inventory, never relax the assertion. DoD 29's "OpenAPI 21/21" should read 22/22 once T1 lands; T7 reports the measured value.

**4. G5 was misdiagnosed, and the spec's own evidence column proved it.** Spec §4.2's G5 row asserted *"the `prisma` CLI is absent from the runtime image"*, citing as evidence that `prisma` is a devDependency and the runtime stage runs `npm ci --omit=dev`. That is a deduction from the manifest, and the built image contradicts it: `prisma` is an optional *peer* of the production `@prisma/client`, so the lockfile marks it `devOptional` and `--omit=dev` keeps it, along with `@prisma/engines` and the schema engine inside it. Measured during T4, not predicted. The gap is now stated in three parts with three owners — (a) no migration artifact ships → T4; (b) the CLI and schema engine are present → **T4a**; (c) the non-contract `.prisma` layout → deferred. **The general lesson, recorded because it outlives this phase: a `devDependencies` declaration is not an absence guarantee when a production dependency peer-depends on the same package, and four green verification gates did not notice.**

**5. Stage order is load-bearing and the spec does not say so.** Spec §9.1 says to add `FROM build AS migrate` without specifying where. `runtime` is currently the **last** stage, and `docker build` with no `--target` builds the last stage — so appending `migrate` at the end would silently make a bare `docker build .` produce a migration container instead of the server. T4 places `migrate` **between** `build` and `runtime` and guards it with an assertion on the default image's `Cmd`.

None of these contradicts a locked decision. D1–D10 are unchanged.

---

## Blockers before Task 1

**None.** Two preconditions and two known costs:

**Preconditions (both satisfiable by the executor, neither blocking):**
- Docker must be running, with `docker compose up -d postgres-test` for every e2e gate, and no other e2e run holding the advisory lock in `test/helpers/e2e-lock.ts`.
- The branch must be created from `master` (`ba59a2a`), **not** from the currently checked-out `phase-5/scheduled-maintenance`. See the Git prerequisite.

**Known costs, pre-authorised by the spec:**
- **R1 — CI container networking.** The highest-probability source of iteration. Resolved by design (user-defined network, T6's rationale), and T6 Step 10 runs the whole sequence locally first to spend the iterations off CI.
- **R2 — C-D3's container half may flake** on Prisma reconnection timing. T6 Step 6 uses bounded polling with generous ceilings. If genuinely unstable, it may be downgraded to the unit equivalent (T1 Step 2) **only as spec §10.4 authorises, with the downgrade and its evidence recorded** in T7 — never quietly deleted.

**One assumption carried into T4 and verified there before anything depends on it:** that `wget` exists in `node:20-alpine` and survives into the runtime stage. T4 Steps 1 and 7 check the base image and the final image separately. If it is absent, **stop and report** — substituting `curl` or installing a package is a spec amendment, not an implementer's choice.
