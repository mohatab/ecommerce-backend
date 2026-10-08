import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, Role } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { TokenService } from '../src/modules/auth/token.service';
import { MaintenanceJobName } from '../src/modules/maintenance/maintenance-job-name.enum';
import { MaintenanceLeaseService } from '../src/modules/maintenance/maintenance-lease.service';
import { ReconciliationFindingWriter } from '../src/modules/maintenance/reconciliation-finding.writer';
import { PrismaService } from '../src/prisma/prisma.service';
import { createOrder } from './factories/order.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';
import { createUser } from './factories/user.factory';
import { createTestApp } from './helpers/create-test-app';
import { resetLeases } from './helpers/reset-leases';
import { truncateAll } from './helpers/truncate';

interface PaginatedBody<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface FindingItem {
  orderId: string;
  paymentId: string | null;
  kind: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  detail: Record<string, unknown>;
}

const RUN = '/api/v1/admin/maintenance';
const FINDINGS = '/api/v1/admin/reconciliation/findings';

describe('admin maintenance API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let writer: ReconciliationFindingWriter;
  let adminToken: string;
  let customerToken: string;

  beforeAll(async () => {
    // The trigger route carries @Throttle({ default: { limit: 5 } }), and this
    // suite issues more than five admin calls. Bypassing the guard is what
    // keeps those failures from masquerading as authorization bugs; the
    // throttle metadata itself is asserted in the OpenAPI inventory.
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    writer = app.get(ReconciliationFindingWriter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await resetLeases(prisma);

    const admin = await createUser(prisma, { role: Role.ADMIN });
    const customer = await createUser(prisma);

    adminToken = await tokens.signAccessToken(admin);
    customerToken = await tokens.signAccessToken(customer);
  });

  describe('POST /admin/maintenance/:job/run', () => {
    const path = (job: string) => `${RUN}/${job}/run`;

    it('returns 401 for an anonymous caller', async () => {
      await request(app.getHttpServer())
        .post(path(MaintenanceJobName.ORDER_EXPIRY))
        .expect(401);
    });

    it('returns 403 for an authenticated customer', async () => {
      await request(app.getHttpServer())
        .post(path(MaintenanceJobName.ORDER_EXPIRY))
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
    });

    it('returns 400 for an unlisted job name, before any dispatch', async () => {
      await request(app.getHttpServer())
        .post(path('drop-everything'))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('returns 409 while the lease is held elsewhere', async () => {
      // A second lease service means a different instanceId, so this is a
      // genuine foreign holder rather than a re-entrant acquire.
      const other = new MaintenanceLeaseService(prisma, app.get(ConfigService));

      await expect(
        other.acquire(MaintenanceJobName.ORDER_EXPIRY),
      ).resolves.toBe('acquired');

      await request(app.getHttpServer())
        .post(path(MaintenanceJobName.ORDER_EXPIRY))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
    });

    it('releases the lease again, so a second call is not stuck at 409', async () => {
      await request(app.getHttpServer())
        .post(path(MaintenanceJobName.PAYMENT_RECONCILIATION))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(path(MaintenanceJobName.PAYMENT_RECONCILIATION))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it.each(Object.values(MaintenanceJobName))(
      'runs %s and returns a summary with no identifiers or provider data',
      async (job) => {
        const response = await request(app.getHttpServer())
          .post(path(job))
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        const body = response.body as Record<string, unknown>;

        expect(Object.keys(body).sort()).toEqual(
          [
            'affected',
            'durationMs',
            'examined',
            'failed',
            'job',
            'skipped',
            'startedAt',
            'status',
          ].sort(),
        );
        expect(JSON.stringify(body)).not.toMatch(/clientSecret|pi_|cus_/);
      },
    );

    it('actually runs the job rather than reporting a no-op', async () => {
      const user = await createUser(prisma);
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 8,
      });

      await createOrder(
        prisma,
        user.id,
        [
          {
            productId: product.id,
            productName: product.name,
            unitPriceCents: 4999,
            quantity: 2,
          },
        ],
        { expiresAt: new Date(Date.now() - 60_000) },
      );

      const response = await request(app.getHttpServer())
        .post(path(MaintenanceJobName.ORDER_EXPIRY))
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toMatchObject({ examined: 1, affected: 1 });
      await expect(
        prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
      ).resolves.toMatchObject({ stockQuantity: 10 });
    });
  });

  describe('GET /admin/reconciliation/findings', () => {
    let activeOrderId: string;
    let resolvedOrderId: string;

    beforeEach(async () => {
      const user = await createUser(prisma);
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const line = {
        productId: product.id,
        productName: product.name,
        unitPriceCents: 4999,
        quantity: 1,
      };

      activeOrderId = (await createOrder(prisma, user.id, [line])).id;
      resolvedOrderId = (
        await createOrder(prisma, user.id, [line], {
          status: OrderStatus.CANCELLED,
        })
      ).id;

      await writer.record(activeOrderId, null, 'AMOUNT_MISMATCH', {
        orderTotalCents: 4999,
      });
      await writer.record(resolvedOrderId, null, 'CURRENCY_MISMATCH', {
        orderCurrency: 'USD',
      });
      await writer.resolve(resolvedOrderId, 'CURRENCY_MISMATCH');
    });

    it('returns 401 for an anonymous caller', async () => {
      await request(app.getHttpServer()).get(FINDINGS).expect(401);
    });

    it('returns 403 for an authenticated customer', async () => {
      await request(app.getHttpServer())
        .get(FINDINGS)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
    });

    it('defaults to ACTIVE findings only', async () => {
      const response = await request(app.getHttpServer())
        .get(FINDINGS)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const page = response.body as PaginatedBody<FindingItem>;

      expect(page.data.map((row) => row.kind)).toEqual(['AMOUNT_MISMATCH']);
      expect(page.data[0].orderId).toBe(activeOrderId);
      expect(page.data[0].resolvedAt).toBeNull();
      expect(page.meta.total).toBe(1);
    });

    it('returns the historical ones for resolved=true', async () => {
      const response = await request(app.getHttpServer())
        .get(`${FINDINGS}?resolved=true`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const page = response.body as PaginatedBody<FindingItem>;

      expect(page.data.map((row) => row.orderId)).toEqual([resolvedOrderId]);
      expect(page.data[0].resolvedAt).not.toBeNull();
    });

    it('filters by kind', async () => {
      const response = await request(app.getHttpServer())
        .get(`${FINDINGS}?kind=CURRENCY_MISMATCH`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((response.body as PaginatedBody<FindingItem>).meta.total).toBe(0);
    });

    it('rejects an unlisted kind with 400', async () => {
      await request(app.getHttpServer())
        .get(`${FINDINGS}?kind=EVERYTHING_IS_FINE`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('rejects a non-boolean resolved with 400 rather than guessing', async () => {
      await request(app.getHttpServer())
        .get(`${FINDINGS}?resolved=yes`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('maps through the DTO, exposing no internal columns', async () => {
      const response = await request(app.getHttpServer())
        .get(FINDINGS)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const [row] = (response.body as PaginatedBody<FindingItem>).data;

      expect(Object.keys(row).sort()).toEqual(
        [
          'detail',
          'firstSeenAt',
          'kind',
          'lastSeenAt',
          'occurrences',
          'orderId',
          'paymentId',
          'resolvedAt',
        ].sort(),
      );
    });

    it('paginates with the existing primitives', async () => {
      const response = await request(app.getHttpServer())
        .get(`${FINDINGS}?page=2&limit=1`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const page = response.body as PaginatedBody<FindingItem>;

      expect(page.meta).toEqual({
        page: 2,
        limit: 1,
        total: 1,
        totalPages: 1,
      });
      expect(page.data).toEqual([]);
    });
  });
});
