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
