import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createHttpTestApp } from './create-http-test-app';

const PAY = '/api/v1/payments/pay/cm3intent00000000000000001';
const WEB = 'http://localhost:3000';
const ADMIN = 'http://localhost:5173';
const MINI_APP = 'https://miniapp.example.uz';

// The pay page on WEB_URL calls the API on another origin (ggpin.uz -> api.ggpin.uz) with the
// X-Pay-Token header, so the browser preflights it (D-39). That header is allowed on the pay
// path only, and only for WEB_URL; the preflight is answered before routing, so no service is
// needed (Postgres/Redis/queues are faked).
describe('CORS of the pay view (GET /payments/pay/:intentId)', () => {
  let app: NestFastifyApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createHttpTestApp({ env: { MINI_APP_URL: `${MINI_APP}/tg` } });
  });
  afterAll(async () => {
    await app.close();
  });

  const preflight = (path: string, origin: string, method = 'GET') =>
    http()
      .options(path)
      .set('Origin', origin)
      .set('Access-Control-Request-Method', method)
      .set('Access-Control-Request-Headers', 'x-pay-token');

  it('WEB_URL: the preflight allows GET with X-Pay-Token, without credentials', async () => {
    const res = await preflight(PAY, WEB);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toBe('x-pay-token');
    expect(res.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('also with a query string (the policy is chosen by the path)', async () => {
    const res = await preflight(`${PAY}?x=1`, WEB);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
  });

  it.each([ADMIN, MINI_APP, 'https://evil.example'])(
    '%s: no Access-Control-Allow-Origin on the pay path',
    async (origin) => {
      const res = await preflight(PAY, origin);
      expect(res.status).toBeLessThan(500);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  it('every other path keeps the default policy: credentials on, X-Pay-Token not allowed', async () => {
    const res = await preflight('/api/v1/payments/intents', WEB, 'POST');
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).not.toContain(
      'x-pay-token',
    );
  });
});
