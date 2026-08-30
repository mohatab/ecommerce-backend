import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { ProtectedThrottleProbeModule } from './fixtures/protected-throttle-probe.module';

describe('auth rate limiting (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('throttles repeated login attempts and keeps the standard error shape', async () => {
    const attempt = (): request.Test =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.test', password: 'Test1234!' });

    for (let i = 0; i < 5; i += 1) {
      await attempt().expect(401);
    }

    const blocked = await attempt().expect(429);

    expect(blocked.body).toMatchObject({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too Many Requests',
      timestamp: expect.any(String) as string,
      path: '/api/v1/auth/login',
    });
  });

  it('lets a suite with throttleLimit set bypass the guard entirely', async () => {
    // Any defined value bypasses the guard (it's a boolean trigger, not a
    // numeric cap) — see CreateTestAppOptions.throttleLimit's doc comment.
    const bypassApp = await createTestApp([], { throttleLimit: 999 });

    try {
      const attempt = (): request.Test =>
        request(bypassApp.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: 'nobody@example.test', password: 'Test1234!' });

      // 8 requests: more than the production limit of 5, which would 429 on
      // request 6 without the bypass (proven by the test above).
      for (let i = 0; i < 8; i += 1) {
        await attempt().expect(401);
      }
    } finally {
      await bypassApp.close();
    }
  });

  it('registers ThrottlerGuard before JwtAuthGuard, so an unauthenticated flood is rate-limited', async () => {
    // Uses a test-only protected route with a tight @Throttle (limit 2)
    // instead of the real /auth/me, which sits at the global 100/60s limit
    // and would make this test slow. If the two global guards were ever
    // swapped in AppModule, JwtAuthGuard would reject every request with 401
    // before ThrottlerGuard could increment its counter, and this route
    // would never reach 429 — see the fixture module's comment.
    const orderApp = await createTestApp([ProtectedThrottleProbeModule]);

    try {
      const attempt = (): request.Test =>
        request(orderApp.getHttpServer()).get(
          '/api/v1/protected-throttle-probe',
        );

      await attempt().expect(401);
      await attempt().expect(401);

      const blocked = await attempt().expect(429);
      expect(blocked.body).toMatchObject({ statusCode: 429 });

      await attempt().expect(429);
    } finally {
      await orderApp.close();
    }
  });
});
