import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { API_DEFAULT_VERSION, API_PREFIX } from '../api-path';
import { createHttpAdapter } from '../create-http-adapter';

// The proxy closes the admin API on the public name by PATH (deploy/proxy/Caddyfile, proxy SA
// F-1/F-3/F-4; regression: deploy/proxy/admin-prefix-test.sh). Its rules are written for the way
// this router matches a path. If one of these options changes, the proxy rules and that script
// must be reviewed in the same change: this test pins the behaviour they rely on.

const ADMIN = `/${API_PREFIX}/v${API_DEFAULT_VERSION}/admin`;

async function routerWithAdminRoutes(): Promise<FastifyInstance> {
  const fastify = createHttpAdapter(buildTestEnv()).getInstance();
  fastify.get(ADMIN, () => 'admin-root');
  fastify.get(`${ADMIN}/*`, () => 'admin');
  fastify.get(`/${API_PREFIX}/v${API_DEFAULT_VERSION}/catalog/categories`, () => 'public');
  await fastify.ready();
  return fastify;
}

describe('API router options the proxy path rules rely on', () => {
  let fastify: FastifyInstance;
  let port = 0;
  beforeAll(async () => {
    fastify = await routerWithAdminRoutes();
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    port = (fastify.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await fastify.close();
  });

  // A real socket, not inject(): the request line must reach the router byte for byte (inject
  // parses the URL with WHATWG rules and would resolve the dot segments itself).
  function served(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve(res.statusCode === 200 ? body : String(res.statusCode)));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('the served shape is /api/v1/<route>: prefix "api", URI versioning, default version 1', () => {
    expect(API_PREFIX).toBe('api');
    expect(API_DEFAULT_VERSION).toBe('1');
    const setup = readFileSync(join(__dirname, '../../../app.setup.ts'), 'utf8');
    expect(setup).toMatch(/setGlobalPrefix\(API_PREFIX\)/);
    expect(setup).toMatch(/type:\s*VersioningType\.URI,\s*defaultVersion:\s*API_DEFAULT_VERSION/);
  });

  it.each([
    ['/api/v1/admin', 'admin-root'],
    ['/api/v1/admin/auth/me', 'admin'],
    // Per-segment percent-decoding: %61 is "a", so the proxy must decode before matching.
    ['/api/v1/%61dmin/auth/me', 'admin'],
    // Dot segments are NOT resolved: this reaches the admin wildcard (proxy F-4 refuses them).
    ['/api/v1/admin/../catalog/categories', 'admin'],
    ['/api/v1/catalog/categories', 'public'],
  ])('%s reaches the %s route', async (url, route) => {
    expect(await served(url)).toBe(route);
  });

  it.each([
    '/API/V1/ADMIN/auth/me', // case-sensitive
    '//api/v1/admin/auth/me', // no duplicate-slash merge
    '/api//v1/admin/auth/me',
    '/api/v1/admin;x', // ";" is part of the path, not a delimiter
    '/api/v1/catalog/categories/', // no trailing-slash ignore
  ])(
    '%s does not reach a route (router defaults: caseSensitive, no ignoreDuplicateSlashes, no useSemicolonDelimiter, no ignoreTrailingSlash)',
    async (url) => {
      expect(await served(url)).toBe('404');
    },
  );
});
