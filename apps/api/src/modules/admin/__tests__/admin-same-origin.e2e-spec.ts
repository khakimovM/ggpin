import { CSRF_HEADER } from '@repo/shared';
import { ADMIN_BASE, type Res } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';

const ME = `${ADMIN_BASE}/me`;
const LOGOUT = `${ADMIN_BASE}/logout`;
const UNKNOWN = '/api/v1/admin/no-such-route';

const headerNames = (res: Res): string[] =>
  Object.keys(res.headers)
    .filter((h) => !['date', 'content-length', 'x-request-id'].includes(h))
    .sort();

// P11-S3 (D-73 (10)): the proxy serves the admin API on the SPA's own origin
// (https://admin.ggpin.uz/api/v1/admin/*). A browser sends no Origin on a same-origin GET/HEAD
// fetch, only Sec-Fetch-Site: same-origin; AdminCsrfGuard lets exactly that read through when the
// Host is ADMIN_URL's, and refuses every other Origin-less browser request as before (S2-5).
describe('admin same-origin reads (real app)', () => {
  const t = useAdminE2e();
  const adminHost = (): string => new URL(t.env.ADMIN_URL).host;
  // What the browser sends on the SPA's GET: no Origin, no CSRF header needed on a read.
  const sameOrigin = (cookie: string, extra: Record<string, string> = {}) => ({
    cookie,
    host: adminHost(),
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...extra,
  });

  it('GET and HEAD on the admin Host: 200, the session is read as usual', async () => {
    const { cookie } = await t.login(await t.newAdmin('OWNER'));
    const read = await t.request('GET', ME, sameOrigin(cookie));
    expect(read.statusCode).toBe(200);
    const head = await t.request('HEAD', ME, sameOrigin(cookie));
    expect(head.statusCode).toBe(200);
    const upper = sameOrigin(cookie, { host: adminHost().toUpperCase() });
    expect((await t.request('GET', ME, upper)).statusCode).toBe(200);
    const modeSameOrigin = sameOrigin(cookie, { 'sec-fetch-mode': 'same-origin' });
    expect((await t.request('GET', ME, modeSameOrigin)).statusCode).toBe(200);
    // Still a session route: the same read without a cookie is the one 404.
    expect((await t.request('GET', ME, sameOrigin(''))).statusCode).toBe(404);
  });

  it('every other Origin-less browser read is the one 404, like a missing route', async () => {
    const { cookie } = await t.login(await t.newAdmin('OWNER'));
    const refused: [string, Record<string, string>][] = [
      ['another Host (api.ggpin.uz)', sameOrigin(cookie, { host: 'api.ggpin.uz' })],
      ['the Host without its port', sameOrigin(cookie, { host: 'localhost' })],
      [
        'the Host with :443 (ADMIN_URL is http here)',
        sameOrigin(cookie, { host: `${adminHost()}:443` }),
      ],
      [
        'X-Forwarded-Host = the admin host, Host = api.ggpin.uz',
        sameOrigin(cookie, { host: 'api.ggpin.uz', 'x-forwarded-host': adminHost() }),
      ],
      ['Sec-Fetch-Dest: document', sameOrigin(cookie, { 'sec-fetch-dest': 'document' })],
      ['Sec-Fetch-Dest: iframe', sameOrigin(cookie, { 'sec-fetch-dest': 'iframe' })],
      ['Sec-Fetch-Site: same-site', sameOrigin(cookie, { 'sec-fetch-site': 'same-site' })],
      ['Sec-Fetch-Site: none', sameOrigin(cookie, { 'sec-fetch-site': 'none' })],
      ['Sec-Fetch-Site: cross-site', sameOrigin(cookie, { 'sec-fetch-site': 'cross-site' })],
      ['Sec-Fetch-Mode: no-cors', sameOrigin(cookie, { 'sec-fetch-mode': 'no-cors' })],
      ['Sec-Fetch-Mode: navigate', sameOrigin(cookie, { 'sec-fetch-mode': 'navigate' })],
      ['Origin = WEB_URL', sameOrigin(cookie, { origin: t.env.WEB_URL })],
    ];
    for (const [name, headers] of refused) {
      for (const method of ['GET', 'HEAD'] as const) {
        const read = await t.request(method, ME, headers);
        const unknown = await t.request(method, UNKNOWN, headers);
        expect([name, method, read.statusCode]).toEqual([name, method, 404]);
        expect(unknown.statusCode).toBe(404);
        expect(headerNames(read)).toEqual(headerNames(unknown));
        if (method === 'GET') expect(read.json()).toEqual(unknown.json());
      }
    }
    // The session lives on: the refusals above never touched it.
    expect((await t.request('GET', ME, sameOrigin(cookie))).statusCode).toBe(200);
  });

  it('a same-origin write still needs Origin = ADMIN_URL and the CSRF header', async () => {
    const { cookie } = await t.login(await t.newAdmin('OWNER'));
    const csrf = { [CSRF_HEADER]: 'e2e' };
    const noOrigin = await t.request('POST', LOGOUT, sameOrigin(cookie, csrf), undefined, {});
    expect(noOrigin.statusCode).toBe(404);
    const noToken = sameOrigin(cookie, { origin: t.env.ADMIN_URL });
    expect((await t.request('POST', LOGOUT, noToken, undefined, {})).statusCode).toBe(404);
    expect((await t.request('GET', ME, sameOrigin(cookie))).statusCode).toBe(200);
    // What the browser really sends on a same-origin POST: Origin included. It logs out.
    const write = sameOrigin(cookie, { origin: t.env.ADMIN_URL, ...csrf });
    expect((await t.request('POST', LOGOUT, write, undefined, {})).statusCode).toBeLessThan(300);
    expect((await t.request('GET', ME, sameOrigin(cookie))).statusCode).toBe(404);
  });

  // SA L-3: the one admin GET that writes (its audit row); HEAD never runs it.
  it('audit CSV export: GET 200 + exactly one AUDIT_EXPORT row; HEAD 404 + none', async () => {
    const owner = await t.newAdmin('OWNER');
    const { cookie } = await t.login(owner);
    const filter = `targetType=E2eSameOrigin&targetId=so-${owner.id}`;
    const url = `/api/v1/admin/audit-log/export.csv?${filter}`;
    const exports = () =>
      t.db().auditLog.count({ where: { action: 'AUDIT_EXPORT', actorId: owner.id } });
    expect(await exports()).toBe(0);
    const head = await t.request('HEAD', url, sameOrigin(cookie));
    expect(head.statusCode).toBe(404);
    expect(await exports()).toBe(0);
    const get = await t.request('GET', url, sameOrigin(cookie));
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(await exports()).toBe(1);
    // Refused shapes write nothing either.
    const apiHost = sameOrigin(cookie, { host: 'api.ggpin.uz' });
    expect((await t.request('GET', url, apiHost)).statusCode).toBe(404);
    expect(await exports()).toBe(1);
  });
});
