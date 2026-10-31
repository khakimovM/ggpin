import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createHttpTestApp } from './create-http-test-app';

const BASE = '/api/v1/pipeline-test';

// Config-dependent behaviour (TRUST_PROXY, SWAGGER_ENABLED) needs its own app per case.
describe('HTTP pipeline configuration', () => {
  describe('client IP and TRUST_PROXY', () => {
    const forwarded = (ip: string) => ({ 'X-Forwarded-For': ip });

    // The test client plays the reverse proxy: it appends the real client address last, while a
    // malicious client controls everything to the left of it.
    it('TRUST_PROXY=1: the proxy-appended address is the key, a spoofed left part is ignored', async () => {
      const app = await createHttpTestApp({
        env: { TRUST_PROXY: '1' },
        rateLimit: { ttl: 60_000, limit: 2 },
      });
      try {
        const http = () => request(app.getHttpServer());
        await http().get(`${BASE}/ok`).set(forwarded('198.51.100.1, 203.0.113.1')).expect(200);
        await http().get(`${BASE}/ok`).set(forwarded('198.51.100.2, 203.0.113.1')).expect(200);
        await http().get(`${BASE}/ok`).set(forwarded('198.51.100.3, 203.0.113.1')).expect(429);
        // A different real client behind the same proxy has its own budget.
        await http().get(`${BASE}/ok`).set(forwarded('203.0.113.2')).expect(200);
      } finally {
        await app.close();
      }
    });

    it('TRUST_PROXY=false: a spoofed X-Forwarded-For does not buy a fresh budget', async () => {
      const app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 2 } });
      try {
        const http = () => request(app.getHttpServer());
        await http().get(`${BASE}/ok`).set(forwarded('203.0.113.1')).expect(200);
        await http().get(`${BASE}/ok`).set(forwarded('203.0.113.2')).expect(200);
        await http().get(`${BASE}/ok`).set(forwarded('203.0.113.3')).expect(429);
      } finally {
        await app.close();
      }
    });
  });

  describe('Swagger enabled', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      app = await createHttpTestApp({
        env: { SWAGGER_ENABLED: 'true' },
        rateLimit: { ttl: 60_000, limit: 1000 },
      });
    });
    afterAll(async () => {
      await app.close();
    });

    it('serves /api/docs with a docs-only CSP, API routes keep the strict one', async () => {
      const docs = await request(app.getHttpServer()).get('/api/docs');
      expect(docs.status).toBe(200);
      expect(docs.headers['content-type']).toContain('text/html');
      expect(docs.headers['content-security-policy']).toContain("script-src 'self'");

      const json = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
      expect(json.body).toMatchObject({ openapi: expect.any(String) as string });

      const api = await request(app.getHttpServer()).get(`${BASE}/ok`);
      expect(api.headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none'",
      );
    });
  });
});
