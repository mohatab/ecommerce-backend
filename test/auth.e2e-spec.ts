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

    expect(observableShape(unknown.body as ErrorBody)).toEqual(
      observableShape(wrong.body as ErrorBody),
    );
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
