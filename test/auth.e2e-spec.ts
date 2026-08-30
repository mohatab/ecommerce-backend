import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser, TEST_PASSWORD } from './factories/user.factory';
import { PrismaService } from '../src/prisma/prisma.service';

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: string };
}

interface ErrorBody {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path: string;
}

describe('authentication (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    // This suite issues roughly 7 register and 6 refresh calls against a
    // production limit of 5/min, and the throttle store is shared across
    // the whole file. Without a raised cap the later tests 429 and look
    // like rotation bugs. Throttling itself is covered by
    // auth-throttle.e2e-spec.ts, which uses the real limits.
    app = await createTestApp([], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // The factory's sequence counter resets per spec file and users.email
    // is @unique; the test Postgres is tmpfs-backed and only wiped on
    // container restart, not between npm run test:e2e invocations. Without
    // this, the hardcoded emails below would 409 on the second run.
    await truncateAll(prisma);
  });

  const register = (email: string): request.Test =>
    request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Test1234!' });

  it('registers, then returns the principal from /auth/me', async () => {
    const created = await register('a@example.test').expect(201);
    const body = created.body as AuthBody;

    expect(body.user.email).toBe('a@example.test');
    expect(JSON.stringify(body)).not.toContain('passwordHash');

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);

    expect((me.body as { email: string }).email).toBe('a@example.test');
  });

  it('rejects a duplicate email with 409', async () => {
    await register('dupe@example.test').expect(201);

    await register('dupe@example.test').expect(409);
  });

  it('returns an identical 401 for unknown email and wrong password', async () => {
    await register('real@example.test').expect(201);

    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.test', password: 'Test1234!' })
      .expect(401);

    const wrong = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'real@example.test', password: 'WrongPass1!' })
      .expect(401);

    // Compare the observable error shape excluding `timestamp`, which is
    // legitimately different per response. Any other difference between
    // "unknown email" and "wrong password" would be an email-enumeration
    // oracle, so the comparison is on the full shape, not just `message`.
    const observableShape = (
      body: ErrorBody,
    ): Omit<ErrorBody, 'timestamp'> => ({
      statusCode: body.statusCode,
      message: body.message,
      error: body.error,
      path: body.path,
    });

    // Pin the contract itself, not just that the two agree. Equality alone
    // passes even if both responses drift to something that leaks — say a
    // message naming the failing factor — as long as they leak identically.
    const expected = {
      statusCode: 401,
      message: 'Invalid email or password',
      error: 'Unauthorized',
      path: '/api/v1/auth/login',
    };

    expect(observableShape(unknown.body as ErrorBody)).toEqual(expected);
    expect(observableShape(wrong.body as ErrorBody)).toEqual(expected);
  });

  it('logs in, then returns the principal from /auth/me', async () => {
    // Spec §10 lists register -> login -> /auth/me as one flow. Test 1 covers
    // the register leg; this covers the login leg, so an access token minted
    // by login (not only by register) is proven to satisfy the guard.
    await register('compose@example.test').expect(201);

    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'compose@example.test', password: 'Test1234!' })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${(loggedIn.body as AuthBody).accessToken}`)
      .expect(200);

    expect((me.body as { email: string }).email).toBe('compose@example.test');
  });

  it('rotates the refresh token and invalidates the presented one', async () => {
    const created = await register('rot@example.test').expect(201);
    const first = (created.body as AuthBody).refreshToken;

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);

    const second = (refreshed.body as AuthBody).refreshToken;
    expect(second).not.toBe(first);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(401);
  });

  it('revokes the entire family when a consumed token is replayed', async () => {
    const created = await register('fam@example.test').expect(201);
    const first = (created.body as AuthBody).refreshToken;

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);
    const second = (refreshed.body as AuthBody).refreshToken;

    // Replaying the consumed token burns the lineage...
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(401);

    // ...so the currently-valid successor stops working too.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second })
      .expect(401);
  });

  it('burns only the replayed family, leaving the same user other sessions', async () => {
    // Two sessions for one user: register opens family A, login opens
    // family B. revokeFamily() filters on familyId, but nothing pinned that
    // — swapping it for revokeAllForUser() passed every other test in this
    // suite, and would silently turn one replayed token into a global logout.
    const sessionA = await register('two@example.test').expect(201);
    const sessionB = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'two@example.test', password: 'Test1234!' })
      .expect(200);

    const familyAFirst = (sessionA.body as AuthBody).refreshToken;
    const familyBToken = (sessionB.body as AuthBody).refreshToken;

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: familyAFirst })
      .expect(200);

    // Replay family A's consumed token: family A is compromised and dies.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: familyAFirst })
      .expect(401);

    // Family B was never presented and must be untouched.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: familyBToken })
      .expect(200);
  });

  it('lets only one of two concurrent rotations consume the same token', async () => {
    // The reason rotate() consumes via a compare-and-swap. Under the previous
    // findUnique -> check revokedAt -> update pattern both requests read
    // `revokedAt: null`, both passed the check, and both rotated: two live
    // siblings in one family, with the reuse detection never firing.
    const created = await register('race@example.test').expect(201);
    const token = (created.body as AuthBody).refreshToken;

    const attempt = (): request.Test =>
      request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: token });

    const results = await Promise.all([attempt(), attempt()]);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);

    // Exactly one winner. Honest scope note: two supertest requests in a
    // Promise.all do NOT reliably interleave at rotate()'s read/write
    // boundary — measured, this assertion also passes against the old
    // non-atomic pattern, because the first request usually finishes
    // rotating before the second reads. So this guards the end-to-end
    // contract but does NOT by itself prove atomicity. The deterministic
    // proof is the next test plus the RefreshTokenService unit tests, which
    // do fail against the old pattern.
    expect(statuses).toEqual([200, 401]);
  });

  it('lets only one of two concurrent compare-and-swap consumes win', async () => {
    // Drives the exact statement rotate() consumes with, concurrently, on one
    // row. This is the database guarantee the whole reuse-detection design
    // rests on, and unlike the HTTP test above it is deterministic: Postgres
    // row-locks the UPDATE, so the loser re-evaluates `revoked_at IS NULL`
    // after the winner commits and matches nothing.
    //
    // Paired with the unit test asserting rotate() issues precisely this
    // WHERE clause, the two together close the loop: the query is atomic, and
    // that query is the one the service uses.
    const created = await register('cas@example.test').expect(201);
    const { user } = created.body as AuthBody;

    const row = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: user.id, revokedAt: null },
    });

    const consume = (): Promise<{ count: number }> =>
      prisma.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

    const [first, second] = await Promise.all([consume(), consume()]);

    // One row matched, one matched nothing. A plain update({ where: { id } })
    // would report 1 for both — which is exactly how the token got consumed
    // twice before this changed.
    expect([first.count, second.count].sort()).toEqual([0, 1]);
  });

  it('invalidates refresh tokens after logout', async () => {
    const created = await register('out@example.test').expect(201);
    const body = created.body as AuthBody;

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(401);
  });

  it('logs in a factory-created user with TEST_PASSWORD', async () => {
    // TEST_PASSWORD_HASH is a precomputed argon2id digest that nothing else
    // currently exercises. Driving it through the real login path makes a
    // wrong, truncated, or placeholder digest fail loudly here instead of
    // lying dormant until a later phase surfaces it as a baffling failure.
    const user = await createUser(prisma);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    expect((response.body as AuthBody).user.email).toBe(user.email);
  });
});
