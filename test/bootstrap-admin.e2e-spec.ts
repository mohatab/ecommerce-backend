import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { AdminProbeModule } from './fixtures/admin-probe.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PasswordHasherService } from '../src/modules/auth/password-hasher.service';
import { UsersService } from '../src/modules/users/users.service';
import { bootstrapAdmin } from '../src/scripts/bootstrap-admin';

const ADMIN_EMAIL = 'bootstrap-admin@example.test';
const ADMIN_PASSWORD = 'Bootstrap1234!';

interface AuthBody {
  accessToken: string;
  user: { role: string };
}

describe('admin bootstrap (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let usersService: UsersService;
  let passwordHasher: PasswordHasherService;

  beforeAll(async () => {
    app = await createTestApp([AdminProbeModule], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
    usersService = app.get(UsersService);
    passwordHasher = app.get(PasswordHasherService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const run = (): Promise<string> =>
    bootstrapAdmin({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      usersService,
      passwordHasher,
    });

  it('produces an ADMIN that can log in and reach a role-restricted route', async () => {
    expect(await run()).toBe('created');

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    const body = login.body as AuthBody;
    expect(body.user.role).toBe(Role.ADMIN);

    await request(app.getHttpServer())
      .get('/api/v1/admin-probe')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
  });

  it('is idempotent and never rewrites an existing password', async () => {
    expect(await run()).toBe('created');

    const first = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN_EMAIL },
    });

    expect(await run()).toBe('unchanged');

    const second = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN_EMAIL },
    });

    expect(second.passwordHash).toBe(first.passwordHash);
    expect(second.role).toBe(Role.ADMIN);
    expect(await prisma.user.count({ where: { email: ADMIN_EMAIL } })).toBe(1);
  });

  it('promotes an existing customer and leaves their password working', async () => {
    // Registered through the real public endpoint — not a factory — so this
    // exercises the promotion path an operator actually hits.
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(201);

    expect(await run()).toBe('promoted');

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    expect((login.body as AuthBody).user.role).toBe(Role.ADMIN);
  });
});
