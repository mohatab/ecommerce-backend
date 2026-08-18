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
    // first. randomUUID() sidesteps that without adding a truncate step
    // that would race other suites' fixtures within this same run.
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
