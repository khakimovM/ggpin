import { ACCESS_COOKIE_NAME, CSRF_HEADER } from '@repo/shared';
import { ADMIN_BASE, setCookies, type Res } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';

const ME = `${ADMIN_BASE}/me`;
const LOGOUT = `${ADMIN_BASE}/logout`;
const USER_ME = '/api/v1/me';
const EVIL = 'https://evil.example';

const without = (headers: Record<string, string>, name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
const headerNames = (res: Res): string[] =>
  Object.keys(res.headers)
    .filter((h) => !['date', 'content-length', 'x-request-id'].includes(h))
    .sort();

// The request shape every admin route demands (D-63 (9), docs/10): the SPA's Origin, fetch mode
// and CSRF header; everything else is a 404 that looks like a missing route. And the two surfaces
// (store and admin) never accept each other's credentials or CORS origin.
describe('admin request shape (real app)', () => {
  const t = useAdminE2e();

  const refusals = (spa: Record<string, string>): [string, Record<string, string>][] => [
    ['Origin = WEB_URL', { ...spa, origin: t.env.WEB_URL }],
    ['a foreign Origin', { ...spa, origin: EVIL }],
    ['Sec-Fetch-Site: cross-site', { ...spa, 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Mode: no-cors', { ...spa, 'sec-fetch-mode': 'no-cors' }],
    ['Sec-Fetch-Mode: navigate', { ...spa, 'sec-fetch-mode': 'navigate' }],
  ];
  const writeOnly = (spa: Record<string, string>): [string, Record<string, string>][] => [
    ['no CSRF header', without(spa, CSRF_HEADER)],
    ['no Origin', without(spa, 'origin')],
  ];

  it('POST /start: the SPA shape is 200; any other shape is 404', async () => {
    for (const [name, headers] of [...refusals(t.spa()), ...writeOnly(t.spa())]) {
      const res = await t.request('POST', `${ADMIN_BASE}/start`, headers, undefined, {});
      expect([name, res.statusCode]).toEqual([name, 404]);
    }
    const ok = await t.request('POST', `${ADMIN_BASE}/start`, t.spa(), undefined, {});
    expect(ok.statusCode).toBe(200);
    t.trackNonce(ok.json<{ data: { nonce: string } }>().data.nonce);
  });

  it('with a valid session cookie: GET and POST refused the same way, and the session lives on', async () => {
    const { cookie } = await t.login(await t.newAdmin('OWNER'));
    const spa = t.spa({ cookie });
    for (const [name, headers] of refusals(spa)) {
      const read = await t.request('GET', ME, headers);
      const unknown = await t.request('GET', '/api/v1/admin/no-such-route', headers);
      expect(unknown.statusCode).toBe(404);
      expect([name, read.statusCode]).toEqual([name, 404]);
      // Indistinguishable from a route that does not exist.
      expect(read.json()).toEqual(unknown.json());
      expect(headerNames(read)).toEqual(headerNames(unknown));
    }
    for (const [name, headers] of [...refusals(spa), ...writeOnly(spa)]) {
      const write = await t.request('POST', LOGOUT, headers, undefined, {});
      expect([name, write.statusCode]).toEqual([name, 404]);
    }
    // S2-5: a browser request (Sec-Fetch-Site present) must carry Origin = ADMIN_URL; the one
    // exception, a same-origin read on ADMIN_URL's Host, is admin-same-origin.e2e-spec.ts.
    expect((await t.request('GET', ME, without(spa, 'origin'))).statusCode).toBe(404);
    const sameOrigin = {
      ...without(spa, 'origin'),
      'sec-fetch-site': 'same-origin',
      'sec-fetch-dest': 'empty',
    };
    const apiHost = { ...sameOrigin, host: 'api.ggpin.uz' };
    expect((await t.request('GET', ME, apiHost)).statusCode).toBe(404);
    expect((await t.request('HEAD', ME, apiHost)).statusCode).toBe(404);
    const wrongPort = { ...sameOrigin, host: 'localhost:80' };
    expect((await t.request('GET', ME, wrongPort)).statusCode).toBe(404);
    // Neither header (curl, a script): only the Origin rule applies, as before.
    const bare = without(without(without(spa, 'origin'), 'sec-fetch-site'), 'sec-fetch-mode');
    expect((await t.request('GET', ME, bare)).statusCode).toBe(200);
    expect((await t.request('GET', ME, spa)).statusCode).toBe(200); // the SPA
  });

  it('Origin = WEB_URL on an admin GET: no Access-Control-Allow-Origin and a 404', async () => {
    const { cookie } = await t.login(await t.newAdmin('SUPPORT'));
    const res = await t.request('GET', ME, t.spa({ cookie, origin: t.env.WEB_URL }));
    expect(res.statusCode).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS: admin paths allow only ADMIN_URL (with credentials); store paths never ADMIN_URL', async () => {
    const preflight = (url: string, origin: string) =>
      t.app().inject({
        method: 'OPTIONS',
        url,
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': `content-type,${CSRF_HEADER}`,
        },
      });
    const admin = await preflight(LOGOUT, t.env.ADMIN_URL);
    expect(admin.headers['access-control-allow-origin']).toBe(t.env.ADMIN_URL);
    expect(admin.headers['access-control-allow-credentials']).toBe('true');
    for (const origin of [t.env.WEB_URL, EVIL]) {
      expect((await preflight(LOGOUT, origin)).headers['access-control-allow-origin']).toBe(
        undefined,
      );
    }
    expect((await preflight(USER_ME, t.env.ADMIN_URL)).headers['access-control-allow-origin']).toBe(
      undefined,
    );
    expect((await preflight(USER_ME, t.env.WEB_URL)).headers['access-control-allow-origin']).toBe(
      t.env.WEB_URL,
    );
  });

  it('a store cookie or Bearer opens no admin route (404); the admin cookie opens no store route (401)', async () => {
    const access = await t.loginUser();
    const userCookie = `${ACCESS_COOKIE_NAME}=${access}`;
    expect((await t.request('GET', USER_ME, { cookie: userCookie })).statusCode).toBe(200);
    expect((await t.request('GET', ME, t.spa({ cookie: userCookie }))).statusCode).toBe(404);
    const bearer = t.spa({ authorization: `Bearer ${access}` });
    expect((await t.request('GET', ME, bearer)).statusCode).toBe(404);

    const { cookie } = await t.login(await t.newAdmin('OWNER'));
    expect((await t.request('GET', USER_ME, { cookie })).statusCode).toBe(401);
    expect((await t.request('GET', USER_ME, { cookie, origin: t.env.ADMIN_URL })).statusCode).toBe(
      401,
    );
  });

  it('two admin session cookies in one request: 404, never "the first one wins"', async () => {
    const one = await t.login(await t.newAdmin('OWNER'));
    const two = await t.login(await t.newAdmin('OWNER'));
    const both = t.spa({ cookie: `${one.cookie}; ${two.cookie}` });
    expect((await t.request('GET', ME, both)).statusCode).toBe(404);
  });
});

describe('admin rate limits (real app)', () => {
  const t = useAdminE2e();
  const retryAfter = (res: Res): number => Number(res.headers['retry-after']);

  it('POST /start: 10 a minute per IP', async () => {
    const ip = t.nextIp();
    for (let i = 0; i < 10; i += 1) {
      const res = await t.request('POST', `${ADMIN_BASE}/start`, t.spa(), ip, {});
      expect(res.statusCode).toBe(200);
      t.trackNonce(res.json<{ data: { nonce: string } }>().data.nonce);
    }
    const over = await t.request('POST', `${ADMIN_BASE}/start`, t.spa(), ip, {});
    expect(over.statusCode).toBe(429);
    expect(retryAfter(over)).toBeGreaterThan(0);
    expect(
      (await t.request('POST', `${ADMIN_BASE}/start`, t.spa(), t.nextIp(), {})).statusCode,
    ).toBe(200);
  });

  it('POST /verify: 30 a minute per IP; GET /status: 300 a minute per IP', async () => {
    const ip = t.nextIp();
    const body = { nonce: 'a'.repeat(43), code: '000000' };
    for (let i = 0; i < 30; i += 1) {
      const res = await t.request('POST', `${ADMIN_BASE}/verify`, t.spa(), ip, body);
      expect(res.statusCode).not.toBe(429);
    }
    expect((await t.request('POST', `${ADMIN_BASE}/verify`, t.spa(), ip, body)).statusCode).toBe(
      429,
    );

    const statusIp = t.nextIp();
    const url = `${ADMIN_BASE}/status/${'a'.repeat(43)}`;
    for (let i = 0; i < 300; i += 1) {
      expect((await t.request('GET', url, t.spa(), statusIp)).statusCode).toBe(404);
    }
    expect((await t.request('GET', url, t.spa(), statusIp)).statusCode).toBe(429);
  });

  it('session routes without a session: 60 a minute per IP, IPv6 counted per /64', async () => {
    const a = '2001:db8:4d1:7a00::1';
    const b = '2001:db8:4d1:7a00:ffff::2'; // same /64
    for (let i = 0; i < 60; i += 1) {
      const res = await t.request('GET', ME, t.spa(), i % 2 === 0 ? a : b);
      expect(res.statusCode).toBe(404);
    }
    const over = await t.request('GET', ME, t.spa(), b);
    expect(over.statusCode).toBe(429);
    expect(retryAfter(over)).toBeGreaterThan(0);
    // Another /64 has its own budget; a refused request shape counts against the address too.
    expect((await t.request('GET', ME, t.spa(), '2001:db8:4d1:7a01::1')).statusCode).toBe(404);
    const v4 = t.nextIp();
    for (let i = 0; i < 60; i += 1) {
      await t.request('GET', ME, t.spa({ 'sec-fetch-mode': 'navigate' }), v4);
    }
    expect((await t.request('GET', ME, t.spa(), v4)).statusCode).toBe(429);
  });

  it('unknown /admin/* paths share the anonymous budget: the 61st answer is the same 429 (S2-1)', async () => {
    const unknown = [
      '/api/v1/admin/no-such-route',
      '/api/v1/admin/users/x/refund',
      '/api/v1/admin',
    ];
    const ip = t.nextIp();
    for (let i = 0; i < 60; i += 1) {
      const url = unknown[i % unknown.length] ?? ME;
      const method = i % 2 === 0 ? 'GET' : 'DELETE';
      expect((await t.request(method, url, t.spa(), ip)).statusCode).toBe(404);
    }
    const real = await t.request('GET', ME, t.spa(), ip);
    const fake = await t.request('GET', '/api/v1/admin/no-such-route', t.spa(), ip);
    const post = await t.request('POST', '/api/v1/admin/nope', t.spa(), ip, {});
    for (const res of [real, fake, post]) expect(res.statusCode).toBe(429);
    const shape = (res: Res) => ({
      body: JSON.stringify(res.json()).replace(/"retryAfterSec":\d+/, ''),
      headers: headerNames(res),
    });
    expect(shape(fake)).toEqual(shape(real));
    expect(shape(post)).toEqual(shape(real));
    // Another address has its own budget: there an unknown path still answers 404.
    expect((await t.request('GET', '/api/v1/admin/nope', t.spa())).statusCode).toBe(404);
  });

  it('one session: 120 requests a minute, 30 of them writes; one log line per window', async () => {
    const reader = await t.newAdmin('OWNER');
    const { cookie } = await t.login(reader);
    for (let i = 0; i < 120; i += 1) {
      expect((await t.request('GET', ME, t.spa({ cookie }))).statusCode).toBe(200);
    }
    const over = await t.request('GET', ME, t.spa({ cookie }));
    expect(over.statusCode).toBe(429);
    await t.request('GET', ME, t.spa({ cookie }));

    const writerAdmin = await t.newAdmin('SUPPORT');
    const writer = await t.login(writerAdmin);
    const write = () =>
      t.request(
        'POST',
        '/api/v1/admin/e2e-probe/write',
        t.spa({ cookie: writer.cookie }),
        undefined,
        {},
      );
    for (let i = 0; i < 30; i += 1) expect((await write()).statusCode).toBe(200);
    expect((await write()).statusCode).toBe(429);
    expect((await t.request('GET', ME, t.spa({ cookie: writer.cookie }))).statusCode).toBe(200);

    const sessionOf = async (adminId: string) =>
      (await t.db().adminSession.findFirstOrThrow({ where: { adminId } })).id;
    const lines = t.logs.text().split('\n');
    const count = (scope: string, sessionId: string) =>
      lines.filter((l) =>
        l.includes(`event=ADMIN_RATE_LIMITED scope=${scope} sessionId=${sessionId}`),
      ).length;
    expect(count('session', await sessionOf(reader.id))).toBe(1);
    expect(count('write', await sessionOf(writerAdmin.id))).toBe(1);
  });
});

describe.each(['production', 'development', 'test'] as const)('admin cookie (%s)', (nodeEnv) => {
  const t = useAdminE2e({ nodeEnv });

  it('verify sets exactly one HttpOnly, SameSite=Strict, Path=/ cookie, no Domain; it opens me', async () => {
    const { res, cookie } = await t.login(await t.newAdmin('OWNER'));
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    const [nameValue = '', ...attrs] = (cookies[0] ?? '').split('; ');
    const name = nodeEnv === 'production' ? '__Host-adm_session' : 'adm_session';
    expect(nameValue.startsWith(`${name}=`)).toBe(true);
    const expected = ['HttpOnly', 'Max-Age=28800', 'Path=/', 'SameSite=Strict'];
    if (nodeEnv !== 'development') expected.push('Secure');
    expect(attrs.sort()).toEqual(expected.sort());
    expect((await t.request('GET', ME, t.spa({ cookie }))).statusCode).toBe(200);
    if (nodeEnv === 'production') {
      const plain = cookie.replace('__Host-adm_session=', 'adm_session=');
      expect((await t.request('GET', ME, t.spa({ cookie: plain }))).statusCode).toBe(404);
    }
  });
});
