import { ADMIN_BASE, type Res } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';

const ADMIN = '/api/v1/admin';
const ME = `${ADMIN_BASE}/me`;
// The router picks the status route with `nonce: ""` and the adapter refuses it (callNotFound).
const EMPTY_PARAM = `${ADMIN_BASE}/status/`;
// The same, percent-encoded: the router decodes `%61` to `a` and still matches the admin route.
const ENCODED_EMPTY_PARAM = `${ADMIN}/%61uth/status/`;

const headerNames = (res: Res): string[] =>
  Object.keys(res.headers)
    .filter((h) => !['date', 'content-length', 'x-request-id'].includes(h))
    .sort();
const shape = (res: Res) => ({
  status: res.statusCode,
  body: res.body.replace(/"retryAfterSec":\d+/, ''),
  headers: headerNames(res),
});

// Admin-prefixed requests that no admin handler runs for: the router's not-found path (S2R-1)
// and the fallback controller's gaps (CR 4). They answer and count exactly like a real route.
describe('admin paths the router does not route (real app)', () => {
  const t = useAdminE2e();

  it('anonymous: empty route parameters (plain and percent-encoded) share the 60/min budget', async () => {
    const ip = t.nextIp();
    const tries: [Parameters<typeof t.request>[0], string][] = [
      ['GET', EMPTY_PARAM],
      ['GET', ENCODED_EMPTY_PARAM],
      ['HEAD', `${ADMIN}/nope`],
      ['GET', `${ADMIN}/orders//refund`],
    ];
    for (let i = 0; i < 60; i += 1) {
      const [method, url] = tries[i % tries.length] ?? ['GET', ME];
      expect([method, url, (await t.request(method, url, t.spa(), ip)).statusCode]).toEqual([
        method,
        url,
        404,
      ]);
    }
    const real = await t.request('GET', ME, t.spa(), ip);
    expect(real.statusCode).toBe(429);
    for (const [method, url] of [
      ['GET', EMPTY_PARAM],
      ['GET', ENCODED_EMPTY_PARAM],
    ] as const) {
      expect([method, shape(await t.request(method, url, t.spa(), ip))]).toEqual([
        method,
        shape(real),
      ]);
    }
  });

  it('before the budget runs out an empty parameter looks like any missing admin path', async () => {
    const ip = t.nextIp();
    const missing = await t.request('GET', `${ADMIN}/no-such-route`, t.spa(), ip);
    const empty = await t.request('GET', EMPTY_PARAM, t.spa(), ip);
    expect(shape(empty)).toEqual(shape(missing));
    expect(missing.statusCode).toBe(404);
  });

  it('paths that only look like admin are the global 404 and never touch the admin budget', async () => {
    const ip = t.nextIp();
    const global = await t.request('GET', '/api/v1/no-such-thing', {}, ip);
    for (let i = 0; i < 61; i += 1) {
      for (const url of ['/api/v1/adminx', '/api/v1/administrator', '/api/v1/adminx/auth/me']) {
        const res = await t.request('GET', url, t.spa(), ip);
        expect([url, res.statusCode]).toEqual([url, 404]);
        if (i === 0) expect(res.json()).toEqual(global.json());
      }
    }
    expect((await t.request('GET', ME, t.spa(), ip)).statusCode).toBe(404); // budget untouched
  });

  it('a live session with the SPA shape: unknown, HEAD and empty-parameter paths are 404', async () => {
    const { cookie } = await t.login(await t.newAdmin('OWNER'));
    const spa = t.spa({ cookie });
    for (const [method, url] of [
      ['GET', `${ADMIN}/nope`],
      ['HEAD', `${ADMIN}/nope`],
      ['DELETE', `${ADMIN}/orders//refund`],
      ['GET', EMPTY_PARAM],
      ['GET', ENCODED_EMPTY_PARAM],
    ] as const) {
      expect([method, url, (await t.request(method, url, spa)).statusCode]).toEqual([
        method,
        url,
        404,
      ]);
    }
    expect((await t.request('GET', ME, spa)).statusCode).toBe(200); // the session lives on
  });

  it('a live session: requests the router does not route count against its own budget', async () => {
    const { cookie } = await t.login(await t.newAdmin('SUPPORT'));
    const spa = t.spa({ cookie });
    // 120 a minute per session: 119 unrouted requests and one real one use it up.
    for (let i = 0; i < 119; i += 1) {
      expect((await t.request('GET', EMPTY_PARAM, spa)).statusCode).toBe(404);
    }
    expect((await t.request('GET', ME, spa)).statusCode).toBe(200);
    const real = await t.request('GET', ME, spa);
    const empty = await t.request('GET', EMPTY_PARAM, spa);
    expect(real.statusCode).toBe(429);
    expect(shape(empty)).toEqual(shape(real));
  });
});
