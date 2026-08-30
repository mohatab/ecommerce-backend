import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';

describe('global auth guard (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a protected route with no token', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('rejects a malformed authorization header', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('rejects "Bearer " carrying an empty token', async () => {
    // The guard's own prefix check passes here — the header does start with
    // "Bearer " — so rejection has to come from verifying the empty string
    // that follows. Nothing pinned this before, and it is the one input that
    // gets past the cheap check with nothing behind it.
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer ')
      .expect(401);
  });

  it('rejects a lowercase "bearer" scheme, which is deliberate', async () => {
    // JwtAuthGuard documents this case-sensitivity as a considered choice
    // (RFC 7235 permits any case; no real client varies it). A choice with no
    // test is only a comment: refactoring the prefix check to
    // `.toLowerCase()` or `.split(' ')[1]` would pass every other test here.
    const email = `case-${randomUUID()}@example.test`;

    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Test1234!' })
      .expect(201);

    const { accessToken } = registered.body as { accessToken: string };

    // Same token, same everything — only the scheme's case differs.
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `bearer ${accessToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('returns the standard error shape on 401', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401);

    expect(response.body).toMatchObject({
      statusCode: 401,
      message: 'Unauthorized',
      error: 'Unauthorized',
      timestamp: expect.any(String) as string,
      path: '/api/v1/auth/me',
    });
  });

  it('leaves /health public', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('leaves login public', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'Test1234!' })
      .expect(401); // reached the handler — not blocked by the guard
  });

  it('allows access to a protected route with a valid access token', async () => {
    // Unique email per run: the e2e Postgres container is tmpfs-backed and
    // only wiped on container restart, not between `npm run test:e2e`
    // invocations, so a hardcoded email would 409 on every run after the
    // first.
    //
    // An earlier version of this comment justified the choice by claiming a
    // truncateAll() step would race other suites' fixtures. That was wrong:
    // `maxWorkers: 1` in test/jest-e2e.json makes the whole e2e run serial,
    // so no two suites are ever in flight together and there is no such race.
    // The honest reason is weaker and sufficient — this suite creates one
    // user and asserts nothing about the table's contents, so a unique email
    // is all it needs; truncating would work equally well.
    const email = `guard-${randomUUID()}@example.test`;

    const registerResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Test1234!' })
      .expect(201);

    const { accessToken } = registerResponse.body as { accessToken: string };

    const meResponse = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect((meResponse.body as { email: string }).email).toBe(email);
  });
});
