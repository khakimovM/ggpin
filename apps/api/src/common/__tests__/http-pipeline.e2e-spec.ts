import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { BODY_LIMIT_BYTES } from '../http/http-limits';
import { createHttpTestApp } from './create-http-test-app';

const BASE = '/api/v1/pipeline-test';
const WEB = 'http://localhost:3000';
const ADMIN = 'http://localhost:5173';

// Fakes for Postgres/Redis/queues (see createHttpTestApp): these suites need no services.
describe('HTTP pipeline (envelope, errors, validation, headers, CORS, limits)', () => {
  describe('default app', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 1000 } });
    });
    afterAll(async () => {
      await app.close();
    });

    const http = () => request(app.getHttpServer());

    it('success -> { success: true, data } with BigInt as strings and ISO dates', async () => {
      const res = await http().get(`${BASE}/ok`).expect(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          id: 'x',
          amountTiyin: '9007199254740993',
          lines: [{ qty: '2' }],
          at: '2026-10-30T10:00:00.000Z',
        },
      });
    });

    it('undefined result -> data: null', async () => {
      const res = await http().get(`${BASE}/nothing`);
      expect(res.body).toEqual({ success: true, data: null });
    });

    it('paginated result carries meta { page, limit, total }', async () => {
      const res = await http().get(`${BASE}/page`).expect(200);
      expect(res.body).toEqual({
        success: true,
        data: [{ priceTiyin: '100' }],
        meta: { page: 2, limit: 20, total: 41 },
      });
    });

    it('valid body passes the Zod pipe', async () => {
      const res = await http().post(`${BASE}/echo`).send({ amount: '1255000', note: 'hi' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true, data: { amount: '1255000', note: 'hi' } });
    });

    it('invalid body -> 400 VALIDATION_ERROR with details.fields and no echo of input', async () => {
      const res = await http()
        .post(`${BASE}/echo`)
        .send({ amount: 'abc', note: 'a-very-long-secret-value', extra: 1 })
        .expect(400);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'errors.VALIDATION_ERROR' },
      });
      const { fields } = (res.body as { error: { details: { fields: unknown[] } } }).error.details;
      expect(fields).toEqual(
        expect.arrayContaining([
          { path: 'amount', code: 'invalid_format' },
          { path: 'note', code: 'too_big' },
        ]),
      );
      expect(JSON.stringify(res.body)).not.toContain('a-very-long-secret-value');
    });

    it('domain error -> contract status, code, i18n key, BigInt details as strings', async () => {
      const res = await http().get(`${BASE}/domain-error`).expect(422);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: 'errors.INSUFFICIENT_BALANCE',
          details: { balance: '100', required: '250', shortfall: '150' },
        },
      });
    });

    it('unknown route -> 404 NOT_FOUND envelope', async () => {
      const res = await http().get('/api/v1/does-not-exist').expect(404);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: 'errors.NOT_FOUND' },
      });
    });

    it('unexpected error -> 500 INTERNAL_ERROR with no stack, message or driver text', async () => {
      const res = await http().get(`${BASE}/boom`).expect(500);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'errors.INTERNAL_ERROR' },
      });
      expect(res.text).not.toMatch(/hunter2|ECONNREFUSED|\bat \S+ \(|\.ts:\d+/);
    });

    it('body above the limit -> 413 PAYLOAD_TOO_LARGE', async () => {
      const big = JSON.stringify({ amount: '1', note: 'x'.repeat(BODY_LIMIT_BYTES) });
      const res = await http()
        .post(`${BASE}/echo`)
        .set('content-type', 'application/json')
        .send(big);
      expect(res.status).toBe(413);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'errors.PAYLOAD_TOO_LARGE' },
      });
    });

    it('malformed JSON -> 400 VALIDATION_ERROR', async () => {
      const res = await http()
        .post(`${BASE}/echo`)
        .set('content-type', 'application/json')
        .send('{"amount": ');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('unsupported media type -> 400 VALIDATION_ERROR (no 415 code in the contract)', async () => {
      const res = await http()
        .post(`${BASE}/echo`)
        .set('content-type', 'text/plain')
        .send('amount=1');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    describe('security headers', () => {
      it('strict CSP, nosniff and no X-Powered-By on API responses', async () => {
        const res = await http().get(`${BASE}/ok`);
        expect(res.headers['content-security-policy']).toBe(
          "default-src 'none';frame-ancestors 'none'",
        );
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-powered-by']).toBeUndefined();
      });

      it('error responses carry the same headers', async () => {
        const res = await http().get('/api/v1/does-not-exist');
        expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      });
    });

    describe('CORS', () => {
      it.each([WEB, ADMIN])('allows %s with credentials', async (origin) => {
        const res = await http().get(`${BASE}/ok`).set('Origin', origin).expect(200);
        expect(res.headers['access-control-allow-origin']).toBe(origin);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
        expect(res.headers['vary']).toContain('Origin');
      });

      it('answers a disallowed origin normally but withholds Access-Control-Allow-Origin', async () => {
        const res = await http()
          .get(`${BASE}/ok`)
          .set('Origin', 'https://evil.example')
          .expect(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });

      it('preflight from an allowed origin lists methods and headers', async () => {
        const res = await http()
          .options(`${BASE}/echo`)
          .set('Origin', WEB)
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'content-type,idempotency-key,x-csrf-token');
        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe(WEB);
        expect(res.headers['access-control-allow-methods']).toBe(
          'GET, POST, PATCH, DELETE, OPTIONS',
        );
        const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
        for (const header of ['content-type', 'authorization', 'idempotency-key', 'x-csrf-token']) {
          expect(allowed).toContain(header);
        }
      });

      it('preflight from a disallowed origin gets no Access-Control-Allow-Origin', async () => {
        const res = await http()
          .options(`${BASE}/echo`)
          .set('Origin', 'https://evil.example')
          .set('Access-Control-Request-Method', 'POST');
        expect(res.status).toBeLessThan(500);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });
    });

    describe('health stays unenveloped', () => {
      it('/health/live', async () => {
        const res = await http().get('/api/v1/health/live').expect(200);
        expect(res.body).toEqual({ status: 'ok' });
      });

      it('/health/ready', async () => {
        const res = await http().get('/api/v1/health/ready').expect(200);
        expect(res.body).toEqual({
          status: 'ok',
          db: 'ok',
          redis: 'ok',
          worker: 'ok',
          fragment: 'disabled',
        });
      });
    });

    it('Swagger is not mounted when SWAGGER_ENABLED is off', async () => {
      const res = await http().get('/api/docs').expect(404);
      expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    });
  });

  describe('rate limiting', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 3 } });
    });
    afterAll(async () => {
      await app.close();
    });

    it('429 RATE_LIMITED with Retry-After after the limit; health is never throttled', async () => {
      const http = () => request(app.getHttpServer());
      for (let i = 0; i < 3; i += 1) await http().get(`${BASE}/ok`).expect(200);
      const limited = await http().get(`${BASE}/ok`);
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'errors.RATE_LIMITED' },
      });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      for (let i = 0; i < 10; i += 1) {
        await http().get('/api/v1/health/live').expect(200);
        await http().get('/api/v1/health/ready').expect(200);
      }
    });
  });
});
