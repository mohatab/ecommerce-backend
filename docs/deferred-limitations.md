# Deferred limitations

Known, accepted gaps in what ships today, each with the phase that owns it.

This file exists because these decisions previously lived only in the
subagent-driven-development ledger under `.superpowers/`, which is **gitignored** —
invisible in a fresh clone and to anyone reviewing a pull request. A deferred
security limitation that nobody can find has been forgotten, not deferred.

Nothing here is a bug report. Each item was considered and consciously postponed.
**Do not close one by deleting the entry** — close it by shipping the fix, then
saying so here.

---

## Security

### Rate limiting keys on `req.ip`, with no trusted-proxy configuration

**Owner: Phase 6 (deployment) — must be settled before the API sits behind a proxy.**

`ThrottlerGuard` buckets by `req.ip`. Nothing calls `app.set('trust proxy', …)`,
so behind a reverse proxy, load balancer, or CDN, Express reports the *proxy's*
address for every request. Both failure modes are bad and neither is loud:

- **Without `trust proxy`:** every client collapses into one bucket. The
  5-per-minute limit on `login` becomes 5 per minute *for the entire internet* —
  a trivial denial of service against all users at once.
- **With `trust proxy` enabled naively:** `X-Forwarded-For` is attacker-supplied,
  so any caller can rotate the header and bypass the limit entirely.

The correct setting depends on the deployment topology (how many proxies sit in
front, and which are trusted), which is why it is not guessed at now. Whoever
deploys this must set it deliberately.

Direct-to-Node deployments are unaffected.

### Registration reveals whether an email is already in use

**Owner: none — accepted by design.** See the Phase 1 design spec §15.

`POST /auth/register` returns 409 for a duplicate address, which confirms that
address is registered. Closing it requires always returning 201 and moving
confirmation to email, and no phase of this roadmap has mail infrastructure.

Note the asymmetry is deliberate, not an oversight: **login** goes to
considerable lengths to avoid the same leak (unconditional argon2 verification
against a boot-derived dummy digest), because login is the endpoint an attacker
would grind. Registration is rate-limited to 5/minute, which bounds enumeration
speed without eliminating it.

### Refresh-token families have no absolute lifetime

**Owner: unscheduled.**

Every rotation issues a successor with a *fresh* full `JWT_REFRESH_TTL`, so a
family that is used regularly never expires. This is ordinary sliding-window
behaviour and reuse detection still bounds a stolen token's usefulness, but there
is no hard ceiling on how long a single lineage can live. If a maximum session
age is ever required (a compliance regime usually forces this), it needs an
absolute expiry recorded at family creation and checked on every rotation.

---

## Operations

### `refresh_tokens` rows are never deleted

**Owner: Phase 5 (Redis + BullMQ).**

Rotation inserts one row per refresh and only ever sets `revoked_at`; nothing
purges expired or revoked rows. This is disk growth, not a latency problem —
every lookup is by a unique or indexed column — but the table grows without
bound in proportion to total refreshes ever performed.

Phase 5 introduces the background job infrastructure this belongs in. A periodic
job deleting rows where `expires_at` is in the past is sufficient; add an index on
`expires_at` at the same time, since no current query needs one.

### The runtime image's Prisma setup is undeclared and untested

**Owner: Phase 6 (deployment).**

Two related gaps in `Dockerfile`:

- The runtime stage copies the generated client from the build stage
  (`node_modules/.prisma`) after `npm ci --omit=dev`. This works, but depends on
  generated-output layout that is not part of Prisma's public contract.
- The `prisma` CLI is a devDependency, so `prisma migrate deploy` **cannot run
  from the runtime image**. That is consistent with the foundation spec's rule
  that migrations run as a discrete release command and never at application
  boot, but it means the release process must supply the CLI separately.

Compounding both: CI **builds** the image but never **runs** it, so "the image
builds" is currently the only assurance — it is not evidence that the container
starts, connects, and serves. A smoke test that boots the image against a
throwaway database belongs with the deployment work.

---

## Testing

### The e2e suite must stay serial (`maxWorkers: 1`)

**Owner: unscheduled — a standing constraint, not a to-do.**

`test/helpers/truncate.ts` reads `pg_tables` and then builds a `TRUNCATE` from the
result, with no lock between the two statements. Concurrent workers sharing one
database race there — confirmed to fail intermittently on a cold cache.

`maxWorkers: 1` in `test/jest-e2e.json` is the mitigation, and several things now
quietly depend on it: `test/factories/user.factory.ts` hands out sequential emails
that only stay unique because nothing runs in parallel.

**Do not raise `maxWorkers` until per-worker database isolation exists.** Raising
it produces intermittent, misleading failures that look like application bugs.

### The test database persists between runs

Not a defect, but it surprises people. The e2e Postgres is tmpfs-backed and wiped
only on **container restart** — not between `npm run test:e2e` invocations. A suite
using fixed email addresses must call `truncateAll()` (see `test/auth.e2e-spec.ts`)
or generate unique addresses per run (see `test/auth-guard.e2e-spec.ts`). Either
works; a suite that does neither passes once and then 409s forever.
