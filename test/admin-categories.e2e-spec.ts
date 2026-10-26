import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser } from './factories/user.factory';
import { PrismaService } from '../src/prisma/prisma.service';

interface CategoryItem {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

interface PaginatedBody<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface ProductItem {
  id: string;
  categoryId: string;
}

/**
 * Spec: docs/superpowers/specs/2026-10-26-admin-category-write-design.md
 *
 * `CategoriesService.create()` has shipped since Phase 2 with no HTTP caller,
 * so on a fresh database every `POST /api/v1/admin/products` returned 409
 * (`P2003`) forever. The service already has unit coverage
 * (categories.service.spec.ts:61) and e2e coverage against real PostgreSQL
 * (categories-service.e2e-spec.ts), so what is new here is purely HTTP-level:
 * routing, the guard chain, DTO validation, and status mapping. That is why
 * this suite exists and why no controller unit test does.
 */
describe('admin categories (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    // throttleLimit mirrors admin-products.e2e-spec.ts:65. This suite fires
    // ~25 requests at one handler against a 100/min per-handler cap, and a 429
    // partway through would masquerade as an auth failure.
    app = await createTestApp([], { throttleLimit: 1000 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  const PATH = '/api/v1/admin/categories';
  const body = { name: 'Desks', slug: 'desks' };

  const adminToken = async (): Promise<string> => {
    const admin = await createUser(prisma, { role: Role.ADMIN });
    return app.get(JwtService).sign(
      { sub: admin.id, role: Role.ADMIN },
      {
        secret: realJwtSecret(),
        algorithm: 'HS256',
        expiresIn: '15m',
      },
    );
  };

  const customerToken = async (): Promise<string> => {
    const customer = await createUser(prisma, { role: Role.CUSTOMER });
    return app.get(JwtService).sign(
      { sub: customer.id, role: Role.CUSTOMER },
      {
        secret: realJwtSecret(),
        algorithm: 'HS256',
        expiresIn: '15m',
      },
    );
  };

  // Local, like admin-products.e2e-spec.ts:101-113. Not extracted: extracting
  // would modify a shipped test file for no behavioural gain.
  const claimToken = (userId: string, secret: string): string =>
    new JwtService().sign(
      { sub: userId, role: Role.ADMIN },
      { secret, algorithm: 'HS256' },
    );

  const realJwtSecret = (): string => {
    const secret = app.get(ConfigService).get<string>('jwt.secret');
    if (!secret) {
      throw new Error('jwt.secret is not configured for the test app');
    }
    return secret;
  };

  describe('authorization matrix', () => {
    it('returns 401 without a token, and creates nothing', async () => {
      await request(app.getHttpServer()).post(PATH).send(body).expect(401);

      expect(await prisma.category.count()).toBe(0);
    });

    it('returns 403 for a CUSTOMER token, and creates nothing', async () => {
      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${await customerToken()}`)
        .send(body)
        .expect(403);

      expect(await prisma.category.count()).toBe(0);
    });

    it('returns 201 with the created category for an ADMIN', async () => {
      const response = await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${await adminToken()}`)
        .send(body)
        .expect(201);

      const created = response.body as CategoryItem & { updatedAt?: string };

      expect(created).toMatchObject({ name: 'Desks', slug: 'desks' });
      expect(created.id).toEqual(expect.any(String));
      expect(created.createdAt).toEqual(expect.any(String));
      // CategoryResponseDto maps field by field and omits updatedAt. A spread
      // would leak it, which is the defect this assertion exists to catch.
      expect(created).not.toHaveProperty('updatedAt');

      expect(await prisma.category.count()).toBe(1);
    });

    it('returns 401 for a forged ADMIN token signed with the wrong secret, and creates nothing', async () => {
      const admin = await createUser(prisma, { role: Role.ADMIN });
      const forged = claimToken(admin.id, 'not-the-real-secret');

      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${forged}`)
        .send(body)
        .expect(401);

      expect(await prisma.category.count()).toBe(0);
    });

    it('control: the identical payload signed with the real secret succeeds', async () => {
      const admin = await createUser(prisma, { role: Role.ADMIN });
      const control = claimToken(admin.id, realJwtSecret());

      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${control}`)
        .send(body)
        .expect(201);

      expect(await prisma.category.count()).toBe(1);
    });
  });

  describe('discoverability', () => {
    it('returns the new category from the public GET /api/v1/categories', async () => {
      const created = await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${await adminToken()}`)
        .send(body)
        .expect(201);

      const listed = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .expect(200);

      const page = listed.body as PaginatedBody<CategoryItem>;

      expect(page.data).toHaveLength(1);
      expect(page.data[0].id).toBe((created.body as CategoryItem).id);
      expect(page.meta.total).toBe(1);
    });
  });

  describe('duplicates, through the central P2002 map', () => {
    it('returns 409 for a duplicate name', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Desks', slug: 'other-desks' })
        .expect(409);

      expect(await prisma.category.count()).toBe(1);
    });

    it('returns 409 for a duplicate slug', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Other Desks', slug: 'desks' })
        .expect(409);

      expect(await prisma.category.count()).toBe(1);
    });

    // Documented behaviour, not a wish: `name` and `slug` are plain PostgreSQL
    // @unique columns, so uniqueness is case-SENSITIVE. A reader may expect a
    // 409 here. Pinned so that making it case-insensitive (a migration) breaks
    // a test rather than surprising someone.
    it('treats name case as distinct: "Desks" then "desks" both return 201', async () => {
      const token = await adminToken();

      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'desks', slug: 'desks-lower' })
        .expect(201);

      expect(await prisma.category.count()).toBe(2);
    });
  });

  describe('validation', () => {
    it.each([
      ['a missing name', { slug: 'desks' }],
      ['a missing slug', { name: 'Desks' }],
      ['a whitespace-only name', { name: '   ', slug: 'desks' }],
      ['a name over 200 characters', { name: 'x'.repeat(201), slug: 'desks' }],
      ['a slug over 100 characters', { name: 'Desks', slug: 'd'.repeat(101) }],
      ['a leading-hyphen slug', { name: 'Desks', slug: '-desks' }],
      ['a trailing-hyphen slug', { name: 'Desks', slug: 'desks-' }],
      ['a doubled-hyphen slug', { name: 'Desks', slug: 'office--desks' }],
      ['an uppercase slug', { name: 'Desks', slug: 'Desks' }],
      ['a spaced slug', { name: 'Desks', slug: 'my desks' }],
      ['an empty slug', { name: 'Desks', slug: '' }],
      ['an unknown extra field', { ...body, colour: 'red' }],
    ])('returns 400 for %s', async (_label, payload) => {
      await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${await adminToken()}`)
        .send(payload)
        .expect(400);

      expect(await prisma.category.count()).toBe(0);
    });

    it.each([['standing-desks'], ['desks2'], ['a'], ['a-b-c']])(
      'accepts the valid slug %s',
      async (slug) => {
        await request(app.getHttpServer())
          .post(PATH)
          .set('Authorization', `Bearer ${await adminToken()}`)
          .send({ name: `Desks ${slug}`, slug })
          .expect(201);
      },
    );
  });

  describe('the fresh-database journey', () => {
    // The assertion that discharges the deferred limitation: on a truncated
    // database, using only the API, a category can be created and a product
    // created against it. Before this route existed, step 2 was a permanent
    // 409 (P2003) with no API path to a category row.
    it('lets an ADMIN create a product against a category created through the API', async () => {
      const token = await adminToken();

      const category = await request(app.getHttpServer())
        .post(PATH)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);

      const categoryId = (category.body as CategoryItem).id;

      const product = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Desk Lamp',
          description: 'An adjustable desk lamp.',
          priceCents: 4999,
          categoryId,
        })
        .expect(201);

      expect((product.body as ProductItem).categoryId).toBe(categoryId);
      expect(await prisma.product.count()).toBe(1);
    });
  });
});
