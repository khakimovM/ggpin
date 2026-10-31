import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createHttpTestApp } from './create-http-test-app';

const BASE = '/api/v1/pipeline-test';

// Config-dependent behaviour (TRUST_PROXY, SWAGGER_ENABLED) needs its own app per case.
describe('HTTP pipeline configuration', () => {
  describe('client IP and TRUST_PROXY', () => {
    // The TCP peer is set with inject({ remoteAddress }): supertest always connects from
    // loopback, which would make "a peer that is not the proxy" impossible to express.
    const PROXY = '203.0.113.10';
    const get = (app: NestFastifyApplication, peer: string, forwardedFor?: string) =>
      app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'GET',
          url: `${BASE}/ok`,
          remoteAddress: peer,
          headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
        });

    // A trusted proxy appends the real client address last; a malicious client controls
    // everything to the left of it.
    it('trusted peer: the right-most untrusted X-Forwarded-For entry is the key, a spoofed left part is ignored', async () => {
      const app = await createHttpTestApp({
        env: { TRUST_PROXY: PROXY },
        rateLimit: { ttl: 60_000, limit: 2 },
      });
      try {
        expect((await get(app, PROXY, '198.51.100.1, 192.0.2.7')).statusCode).toBe(200);
        expect((await get(app, PROXY, '198.51.100.2, 192.0.2.7')).statusCode).toBe(200);
        expect((await get(app, PROXY, '198.51.100.3, 192.0.2.7')).statusCode).toBe(429);
        // A different real client behind the same proxy has its own budget.
        expect((await get(app, PROXY, '192.0.2.8')).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('trusted CIDR (IPv4 and IPv6) is honoured; a trusted proxy hop in the chain is skipped', async () => {
      const app = await createHttpTestApp({
        env: { TRUST_PROXY: '10.0.0.0/8, fd00::/8' },
        rateLimit: { ttl: 60_000, limit: 1 },
      });
      try {
        expect((await get(app, '10.1.2.3', '192.0.2.1')).statusCode).toBe(200);
        expect((await get(app, '10.9.9.9', '192.0.2.1')).statusCode).toBe(429);
        expect((await get(app, 'fd00::5', '192.0.2.2')).statusCode).toBe(200);
        expect((await get(app, 'fd00::6', '192.0.2.2')).statusCode).toBe(429);
        // client -> edge proxy 10.0.0.2 -> proxy 10.0.0.1: the edge hop is not the client.
        expect((await get(app, '10.0.0.1', '192.0.2.3, 10.0.0.2')).statusCode).toBe(200);
        expect((await get(app, '10.0.0.1', '192.0.2.3, 10.0.0.2')).statusCode).toBe(429);
      } finally {
        await app.close();
      }
    });

    it('peer NOT on the list: X-Forwarded-For is ignored, request.ip is the peer', async () => {
      const app = await createHttpTestApp({
        env: { TRUST_PROXY: PROXY },
        rateLimit: { ttl: 60_000, limit: 2 },
      });
      try {
        const direct = '198.51.100.99';
        expect((await get(app, direct, '192.0.2.1')).statusCode).toBe(200);
        expect((await get(app, direct, '192.0.2.2')).statusCode).toBe(200);
        // Spoofing yet another address does not buy a fresh budget.
        expect((await get(app, direct, '192.0.2.3')).statusCode).toBe(429);
        // Another peer has its own budget (the key really is the peer address).
        expect((await get(app, '198.51.100.100', '192.0.2.3')).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('TRUST_PROXY empty (default): X-Forwarded-For is ignored for every peer', async () => {
      const app = await createHttpTestApp({ rateLimit: { ttl: 60_000, limit: 2 } });
      try {
        expect((await get(app, PROXY, '203.0.113.1')).statusCode).toBe(200);
        expect((await get(app, PROXY, '203.0.113.2')).statusCode).toBe(200);
        expect((await get(app, PROXY, '203.0.113.3')).statusCode).toBe(429);
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
