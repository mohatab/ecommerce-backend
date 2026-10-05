import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';

/**
 * Spec §15.2 ("both new routes … appear in the Swagger document with
 * `@ApiTags`, `@ApiOperation` and `@ApiResponse`") and spec §20 item 20 (the
 * route inventory — "exactly two new routes exist"). Nothing in `test/` built
 * an OpenAPI document before Phase 4, so this is the one place that does.
 *
 * Why the document is built here and not shared with `main.ts`: `main.ts` owns
 * Swagger (CLAUDE.md), and its `DocumentBuilder` config is inline by design.
 * Refactoring production code to share a title and a version with a test would
 * buy nothing, because every property asserted below comes from the
 * CONTROLLER DECORATORS, not from the builder. A minimal builder config is
 * therefore equivalent evidence.
 *
 * The document is also the application's real route surface, not a
 * hand-maintained list: `SwaggerModule.createDocument` scans the compiled
 * module graph's controllers. The two live requests at the bottom close the
 * loop between a documented path STRING and a route the HTTP server actually
 * resolves — the part a templated `{id}` or a changed global prefix could
 * silently break.
 */
describe('OpenAPI document (e2e)', () => {
  let app: INestApplication<App>;
  let document: OpenAPIObject;

  const INITIATE_PATH = '/api/v1/orders/{id}/payments';
  const WEBHOOK_PATH = '/api/v1/payments/webhook';

  beforeAll(async () => {
    // throttleLimit bypasses ThrottlerGuard: this suite fires a request at the
    // webhook, and the point here is documentation, not rate limiting.
    app = await createTestApp([], { throttleLimit: 0 });

    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('inventory probe').build(),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const operations = (): string[] =>
    Object.entries(document.paths)
      .flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();

  describe('route inventory (spec §20 item 20, D11)', () => {
    it('documents exactly the routes the application serves', () => {
      // The full surface, pinned. A new route that nobody documented, or a
      // route silently removed, fails here rather than at review time.
      expect(operations()).toEqual([
        'DELETE /api/v1/admin/products/{id}',
        'DELETE /api/v1/cart/items/{productId}',
        'GET /api/v1/auth/me',
        'GET /api/v1/cart',
        'GET /api/v1/categories',
        'GET /api/v1/orders',
        'GET /api/v1/orders/{id}',
        'GET /api/v1/products',
        'GET /api/v1/products/{id}',
        'GET /health',
        'PATCH /api/v1/admin/products/{id}',
        'POST /api/v1/admin/products',
        'POST /api/v1/admin/products/{id}/stock-adjustments',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/refresh',
        'POST /api/v1/auth/register',
        'POST /api/v1/orders',
        'POST /api/v1/orders/{id}/cancel',
        'POST /api/v1/orders/{id}/payments',
        'POST /api/v1/payments/webhook',
        'PUT /api/v1/cart/items/{productId}',
      ]);
    });

    it('adds exactly two payment routes, and no confirm route (D11)', () => {
      // D11: completion is out-of-band. A third payment route — a confirm
      // endpoint, an admin refund, a payment status poller — fails here.
      expect(
        operations().filter((operation) => /payment/i.test(operation)),
      ).toEqual([`POST ${INITIATE_PATH}`, `POST ${WEBHOOK_PATH}`]);
    });

    it('templates the order id rather than keeping the Nest `:id` form', () => {
      // Asserting ':id' would never match; recorded so the next reader does
      // not spend an afternoon on it.
      expect(Object.keys(document.paths)).toContain(INITIATE_PATH);
      expect(Object.keys(document.paths)).not.toContain(
        '/api/v1/orders/:id/payments',
      );
    });
  });

  describe.each([
    ['initiation', INITIATE_PATH, [200, 201, 400, 401, 404, 409, 422, 502]],
    ['webhook', WEBHOOK_PATH, [200, 400]],
  ])('%s — spec §15.2 documentation clause', (_name, path, statuses) => {
    const operation = () => {
      const item = document.paths[path];

      expect(item).toBeDefined();
      expect(item.post).toBeDefined();

      return item.post!;
    };

    it('carries @ApiTags(payments)', () => {
      expect(operation().tags).toContain('payments');
    });

    it('carries @ApiOperation with a non-empty summary', () => {
      const { summary } = operation();

      expect(typeof summary).toBe('string');
      expect(summary?.trim()).not.toBe('');
    });

    it('documents exactly the expected @ApiResponse status codes', () => {
      // An exact set, not a subset: a deleted @ApiResponse fails here, and so
      // does one added without updating spec §9.5. The webhook's set is
      // deliberately 200/400 only — spec §9.4 also lists 429 and 500, which
      // remain undocumented (Task 6 minor M2, still deferred, because closing
      // it means editing a controller under src/).
      expect(Object.keys(operation().responses).sort()).toEqual(
        statuses.map(String).sort(),
      );
    });
  });

  describe('documented paths resolve on the real HTTP server', () => {
    it('resolves the initiation route (401, not 404)', async () => {
      // 401 proves the route matched and the global JwtAuthGuard rejected it.
      await request(app.getHttpServer())
        .post('/api/v1/orders/0195f0a0-0000-7000-8000-0000000000ff/payments')
        .expect(401);
    });

    it('resolves the webhook route (400, not 404 and not 401)', async () => {
      // 400 'Invalid signature' proves both that the route matched and that
      // @Public() is still on it: a 401 here would mean no delivery can ever
      // pay an order.
      await request(app.getHttpServer())
        .post('/api/v1/payments/webhook')
        .send({ id: 'evt_unsigned' })
        .expect(400);
    });
  });
});
