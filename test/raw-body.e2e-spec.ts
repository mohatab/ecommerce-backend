import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './helpers/create-test-app';
import { RawBodyProbeModule } from './fixtures/raw-body-probe.module';

interface RawBodyProbeResponseBody {
  isBuffer: boolean;
  raw: string | null;
  parsedIsObject: boolean;
}

describe('Raw body construction seam (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp([RawBodyProbeModule], { throttleLimit: 0 });
  });

  afterAll(async () => {
    await app.close();
  });

  // Byte-exactness is the whole point: this payload survives JSON.parse but
  // NOT a parse/re-stringify round trip, because the key order and the
  // spacing both change. A webhook HMAC over a re-serialised body would fail
  // for every authentic event.
  const PAYLOAD = '{"b":1,  "a":"\\u00e9"}';

  it('exposes request.rawBody as a Buffer holding the exact bytes sent', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/raw-body-probe')
      .set('Content-Type', 'application/json')
      .send(PAYLOAD)
      .expect(201);

    const body = response.body as RawBodyProbeResponseBody;

    expect(body.isBuffer).toBe(true);
    expect(body.raw).toBe(PAYLOAD);
  });

  it('still parses the body normally, so every other route is unaffected', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/raw-body-probe')
      .set('Content-Type', 'application/json')
      .send(PAYLOAD)
      .expect(201);

    const body = response.body as RawBodyProbeResponseBody;

    expect(body.parsedIsObject).toBe(true);
  });
});
