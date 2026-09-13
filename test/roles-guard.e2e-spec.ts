import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser, TEST_PASSWORD } from './factories/user.factory';
import { AdminProbeModule } from './fixtures/admin-probe.module';
import { PrismaService } from '../src/prisma/prisma.service';

interface AuthBody {
  accessToken: string;
}

describe('roles guard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp([AdminProbeModule], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const login = async (email: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

    return (response.body as AuthBody).accessToken;
  };

  it('returns 401, not 403, when no token is presented', async () => {
    // This is the guard-order assertion. JwtAuthGuard must reject first; if
    // RolesGuard ran before it, request.user would be undefined and the
    // caller would see 403 — the wrong answer and the wrong diagnosis.
    await request(app.getHttpServer()).get('/api/v1/admin-probe').expect(401);
  });

  it('returns 403 for an authenticated CUSTOMER', async () => {
    const user = await createUser(prisma, { role: Role.CUSTOMER });
    const token = await login(user.email);

    await request(app.getHttpServer())
      .get('/api/v1/admin-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('allows an ADMIN', async () => {
    const user = await createUser(prisma, { role: Role.ADMIN });
    const token = await login(user.email);

    await request(app.getHttpServer())
      .get('/api/v1/admin-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('leaves routes without @Roles() reachable by any authenticated caller', async () => {
    const user = await createUser(prisma, { role: Role.CUSTOMER });
    const token = await login(user.email);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('keeps @Public() routes public with the third guard installed', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
