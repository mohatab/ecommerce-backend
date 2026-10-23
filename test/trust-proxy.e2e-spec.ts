import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';

/**
 * The trusted-proxy reference-topology controls (C-D1, C-D2) plus the
 * too-high-hop-count hazard (Review Focus 1) and the single-entry vacuity
 * hazard.
 *
 * TRUST_PROXY_HOPS is set to 1 here DELIBERATELY and legitimately: a test
 * needs SOME topology to assert against, and one proxy hop is the spec's
 * reference topology (section 5.1). The value is injected by this test, local
 * to it, and carries NO authority over any deployment - see spec section 5.2
 * and DoD 15d. It is not a default and must never become one.
 *
 * Why the env var rather than a harness option: `test/` is the one place
 * outside `src/config/` allowed to read and write process.env, and
 * `createTestApp()` compiles AppModule fresh on every call, so a value set
 * before the call is picked up by ConfigModule. `test/setup-e2e.ts` already
 * uses exactly this idiom for MAINTENANCE_JOBS_ENABLED. The save/restore is
 * mandatory: suites share one process under maxWorkers: 1.
 *
 * ISOLATION. A throttle bucket keys on class + handler + IP (60s TTL), and
 * every request here hits the same handler. So each control owns a DISTINCT
 * rightmost (client) address, and no control reads or depends on a bucket
 * another one filled. Every test passes alone (`-t`) and in any order.
 */
describe('trusted proxy (e2e)', () => {
  const originalHops = process.env.TRUST_PROXY_HOPS;

  afterAll(() => {
    if (originalHops === undefined) {
      delete process.env.TRUST_PROXY_HOPS;
    } else {
      process.env.TRUST_PROXY_HOPS = originalHops;
    }
  });

  async function appWithHops(hops: string): Promise<INestApplication<App>> {
    process.env.TRUST_PROXY_HOPS = hops;

    return createTestApp();
  }

  // The 5/min route, which is the tightest control in the repository and the
  // one an attacker would grind.
  const login = (
    app: INestApplication<App>,
    forwardedFor: string,
  ): request.Test =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', forwardedFor)
      .send({ email: 'nobody@example.test', password: 'Test1234!' });

  describe('one-hop reference topology', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await appWithHops('1');
    });

    afterAll(async () => {
      await app.close();
    });

    /**
     * C-D1. Hop counting from the RIGHT: a forged prefix cannot mint a bucket.
     * Real client: 10.0.0.5.
     *
     * The forged prefix ROTATES on every request. With one real proxy in
     * front, that proxy appends the true client address, so the rightmost
     * entry is the only trustworthy one and the bucket must key on it.
     *
     * A SINGLE-ENTRY X-Forwarded-For would make this control VACUOUS: with one
     * entry and hops=1, the forged value IS the rightmost entry, so it is the
     * client by construction and the test would pass against `trust proxy:
     * true` as well. The two-entry shape is the whole point; the test below
     * this one asserts that vacuity permanently.
     */
    it('ignores a rotating forged prefix and still throttles the real client', async () => {
      for (let i = 0; i < 5; i += 1) {
        await login(app, `9.9.9.${i}, 10.0.0.5`).expect(401);
      }

      await login(app, '9.9.9.99, 10.0.0.5').expect(429);
    });

    /**
     * Permanent vacuity check for C-D1. This asserts a HAZARD, not a goal.
     *
     * With hops=1 and a SINGLE-entry header, the forged value is the rightmost
     * entry, so Express takes it as the client. Rotating it mints a fresh
     * bucket per request and the 5/min limit is bypassed. That is exactly why
     * C-D1 must use two entries: a one-entry C-D1 could not tell correct
     * counting from `trust proxy: true`, and would pass against both.
     *
     * It exists to prove the two-entry shape in C-D1 is load-bearing. It is
     * NOT an endorsement of a topology in which clients reach a hop=1 server
     * with a single-entry header; in a real deployment the proxy always
     * appends, so a single entry means the proxy was bypassed. Clients here
     * are 172.16.0.x, disjoint from every other control's.
     */
    it('is bypassed by a rotating single-entry header, which is why C-D1 needs two entries', async () => {
      for (let i = 0; i < 8; i += 1) {
        await login(app, `172.16.0.${i}`).expect(401);
      }
    });

    /**
     * C-D2. Independent buckets per real client - proves we did not simply
     * collapse everyone into one bucket and call it safe. Without any
     * `trust proxy` setting both of these key on the socket address and share
     * a bucket, so the second client would already be blocked.
     * Real clients: 10.0.0.11 and 10.0.0.12.
     */
    it('gives two different real clients independent buckets', async () => {
      for (let i = 0; i < 5; i += 1) {
        await login(app, '9.9.9.9, 10.0.0.11').expect(401);
      }

      await login(app, '9.9.9.9, 10.0.0.11').expect(429);

      // A different rightmost entry: a different client, a fresh budget.
      await login(app, '9.9.9.9, 10.0.0.12').expect(401);
    });
  });

  /**
   * Review Focus 1 - the too-high hop count, demonstrated rather than
   * described.
   *
   * The spec says too high is the dangerous direction. Here it is: with
   * hops=2 but only ONE appending proxy, Express counts past the
   * proxy-appended entry into the attacker-supplied one, so a rotating
   * prefix mints a fresh bucket every request and the 5/min control is gone.
   *
   * This test asserts the BYPASS, so it documents the hazard and will fail
   * loudly if a future change to the hop arithmetic silently "fixes" it. It
   * is not an endorsement of hops=2. Its own app instance, its own prefix
   * range (172.17.0.x).
   */
  describe('a hop count higher than the real chain depth', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await appWithHops('2');
    });

    afterAll(async () => {
      await app.close();
    });

    it('lets a rotating forged prefix bypass the limit entirely', async () => {
      for (let i = 0; i < 8; i += 1) {
        await login(app, `172.17.0.${i}, 10.0.0.5`).expect(401);
      }
    });
  });
});
