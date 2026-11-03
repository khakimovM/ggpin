import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createHttpTestApp } from './create-http-test-app';

const BASE = '/api/v1/pipeline-test';
const WEB = 'http://localhost:3000';

// Fakes for Postgres/Redis/queues (see createHttpTestApp): needs no services. The real
// pipeline runs, so the onSend hook sees the real exception filter, guards and CORS.
describe('Cache-Control policy (default no-store, opt-in public cache)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 1000 } });
  });
  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('cacheable route (@PublicCache(60))', () => {
    it('200 GET -> public, max-age=60', async () => {
      const res = await http().get(`${BASE}/cacheable`).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('HEAD -> public, max-age=60 as well', async () => {
      const res = await http().head(`${BASE}/cacheable`).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it('400 (invalid query) -> no-store', async () => {
      const res = await http().get(`${BASE}/cacheable?fail=nope`).expect(400);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('500 (unexpected error) -> no-store', async () => {
      const res = await http().get(`${BASE}/cacheable?fail=boom`).expect(500);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('a 200 that sets a cookie -> no-store', async () => {
      const res = await http().get(`${BASE}/cacheable-cookie`).expect(200);
      expect(res.headers['set-cookie']).toBeDefined();
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('a 200 that sets a cookie through reply.setCookie (written by @fastify/cookie) -> no-store', async () => {
      const res = await http().get(`${BASE}/cacheable-set-cookie`).expect(200);
      expect(res.headers['set-cookie']).toBeDefined();
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('a non-GET method on the same path (no such route) -> no-store', async () => {
      const res = await http().post(`${BASE}/cacheable`).send({});
      expect(res.status).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('sends Vary: Origin when the request carries an Origin, so a cache cannot cross origins', async () => {
      const res = await http().get(`${BASE}/cacheable`).set('Origin', WEB).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.headers['access-control-allow-origin']).toBe(WEB);
      expect(res.headers.vary).toMatch(/(^|,\s*)Origin(\s*,|$)/i);
    });
  });

  describe('everything else is no-store', () => {
    it('routes without the marker, success or error', async () => {
      for (const path of ['ok', 'nothing', 'page', 'domain-error', 'boom', 'blocked-user']) {
        const res = await http().get(`${BASE}/${path}`);
        expect([path, res.headers['cache-control']]).toEqual([path, 'no-store']);
      }
    });

    it('a 404 on an unmatched path', async () => {
      const res = await http().get('/api/v1/nothing/here').expect(404);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('health, live and ready', async () => {
      for (const path of ['live', 'ready']) {
        const res = await http().get(`/api/v1/health/${path}`).expect(200);
        expect([path, res.headers['cache-control']]).toEqual([path, 'no-store']);
      }
    });

    it('auth and me, anonymous (401)', async () => {
      const me = await http().get('/api/v1/me').expect(401);
      const sessions = await http().get('/api/v1/auth/sessions').expect(401);
      expect(me.headers['cache-control']).toBe('no-store');
      expect(sessions.headers['cache-control']).toBe('no-store');
    });

    it('a percent-encoded spelling of /me is still no-store', async () => {
      const res = await http().get('/api/v1/%6De');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});
