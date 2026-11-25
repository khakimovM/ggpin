import { CSRF_HEADER } from '@repo/shared';
import { adminRequestAllowed } from '../common/admin-csrf.guard';
import type { AdminRequest } from '../common/admin-request';

const ADMIN = 'http://localhost:5173';
const WEB = 'http://localhost:3000';
const ADMIN_HOST = 'localhost:5173';

const without = (
  headers: Record<string, string | string[]>,
  name: string,
): Record<string, string | string[]> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));

function req(method: string, headers: Record<string, string | string[]>): AdminRequest {
  return { method, ip: '203.0.113.9', headers };
}

describe('adminRequestAllowed (docs/04 «CORS va Origin», N5, D-65 (6)(e))', () => {
  const csrf = { [CSRF_HEADER]: 'x' };
  // The SPA's GET on its own origin (admin.ggpin.uz/api/v1/admin/*): no Origin header at all.
  const sameOrigin = {
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    host: ADMIN_HOST,
  };

  it.each<[string, string, Record<string, string | string[]>, boolean]>([
    [
      'the SPA read',
      'GET',
      { origin: ADMIN, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
      true,
    ],
    ['a read without Origin or Sec-Fetch (curl, old browser)', 'GET', {}, true],
    // S2-5: a browser that sends Sec-Fetch-Site must also send Origin = ADMIN_URL, except the
    // SPA's own same-origin read (P11-S3: the admin API on ADMIN_URL's origin, no Origin on GET).
    ['same-site without Origin', 'GET', { 'sec-fetch-site': 'same-site' }, false],
    // The literal pre-P11-S3 case, kept as is: no Sec-Fetch-Dest and no Host -> still refused.
    [
      'same-origin without Origin',
      'GET',
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
      false,
    ],
    [
      'same-site + cors + admin Host, no Origin',
      'GET',
      { ...sameOrigin, 'sec-fetch-site': 'same-site' },
      false,
    ],
    ['none (a typed URL), no Origin', 'GET', { ...sameOrigin, 'sec-fetch-site': 'none' }, false],
    [
      'cross-site + cors + admin Host, no Origin',
      'GET',
      { ...sameOrigin, 'sec-fetch-site': 'cross-site' },
      false,
    ],
    ['same-origin read on the admin Host', 'GET', sameOrigin, true],
    ['same-origin HEAD on the admin Host', 'HEAD', sameOrigin, true],
    [
      'same-origin read, mode same-origin',
      'GET',
      { ...sameOrigin, 'sec-fetch-mode': 'same-origin' },
      true,
    ],
    [
      'same-origin read, Host in upper case',
      'GET',
      { ...sameOrigin, host: 'LOCALHOST:5173' },
      true,
    ],
    [
      'same-origin read without Sec-Fetch-Dest',
      'GET',
      without(sameOrigin, 'sec-fetch-dest'),
      false,
    ],
    [
      'same-origin read, dest document',
      'GET',
      { ...sameOrigin, 'sec-fetch-dest': 'document' },
      false,
    ],
    ['same-origin read, dest iframe', 'GET', { ...sameOrigin, 'sec-fetch-dest': 'iframe' }, false],
    ['same-origin read, dest image', 'GET', { ...sameOrigin, 'sec-fetch-dest': 'image' }, false],
    [
      'same-origin read, dest Empty (not exact)',
      'GET',
      { ...sameOrigin, 'sec-fetch-dest': 'Empty' },
      false,
    ],
    [
      'same-origin read, two Sec-Fetch-Dest',
      'GET',
      { ...sameOrigin, 'sec-fetch-dest': ['empty', 'empty'] },
      false,
    ],
    [
      'same-origin read, two Sec-Fetch-Site',
      'GET',
      { ...sameOrigin, 'sec-fetch-site': ['same-origin', 'same-origin'] },
      false,
    ],
    [
      'same-origin read, two Sec-Fetch-Mode',
      'GET',
      { ...sameOrigin, 'sec-fetch-mode': ['cors', 'cors'] },
      false,
    ],
    ['same-origin OPTIONS', 'OPTIONS', sameOrigin, false],
    [
      'same-origin read, Host with :443 on an http ADMIN_URL',
      'GET',
      { ...sameOrigin, host: 'localhost:5173:443' },
      false,
    ],
    [
      'same-origin read on another Host, X-Forwarded-Host = the admin host',
      'GET',
      { ...sameOrigin, host: 'api.ggpin.uz', 'x-forwarded-host': ADMIN_HOST },
      false,
    ],
    ['same-origin read on another Host', 'GET', { ...sameOrigin, host: 'api.ggpin.uz' }, false],
    ['same-origin read, Host without the port', 'GET', { ...sameOrigin, host: 'localhost' }, false],
    ['same-origin read without Host', 'GET', without(sameOrigin, 'host'), false],
    // A defence layer only (inject/unit): real HTTP never gives an array, Node keeps the first Host.
    [
      'same-origin read, two Host headers',
      'GET',
      { ...sameOrigin, host: [ADMIN_HOST, ADMIN_HOST] },
      false,
    ],
    [
      'same-origin read without Sec-Fetch-Mode',
      'GET',
      without(sameOrigin, 'sec-fetch-mode'),
      false,
    ],
    [
      'same-origin read, mode no-cors',
      'GET',
      { ...sameOrigin, 'sec-fetch-mode': 'no-cors' },
      false,
    ],
    [
      'same-origin read, mode navigate',
      'GET',
      { ...sameOrigin, 'sec-fetch-mode': 'navigate' },
      false,
    ],
    [
      'same-origin read, mode websocket',
      'GET',
      { ...sameOrigin, 'sec-fetch-mode': 'websocket' },
      false,
    ],
    [
      'same-origin, not exactly (upper case)',
      'GET',
      { ...sameOrigin, 'sec-fetch-site': 'Same-Origin' },
      false,
    ],
    ['same-origin read with the web origin', 'GET', { ...sameOrigin, origin: WEB }, false],
    ['same-origin read with ADMIN_URL as Origin', 'GET', { ...sameOrigin, origin: ADMIN }, true],
    ['same-origin POST without Origin', 'POST', { ...sameOrigin, ...csrf }, false],
    ['same-origin PATCH without Origin', 'PATCH', { ...sameOrigin, ...csrf }, false],
    ['same-origin DELETE without Origin', 'DELETE', { ...sameOrigin, ...csrf }, false],
    [
      'same-origin POST with Origin + CSRF',
      'POST',
      { ...sameOrigin, origin: ADMIN, ...csrf },
      true,
    ],
    ['same-origin POST with Origin, no CSRF', 'POST', { ...sameOrigin, origin: ADMIN }, false],
    ['same-site with the web origin', 'GET', { 'sec-fetch-site': 'same-site', origin: WEB }, false],
    ['same-site with ADMIN_URL', 'GET', { 'sec-fetch-site': 'same-site', origin: ADMIN }, true],
    [
      'Sec-Fetch-Mode alone (no Sec-Fetch-Site), no Origin',
      'GET',
      { 'sec-fetch-mode': 'cors' },
      true,
    ],
    ['the web origin', 'GET', { origin: WEB }, false],
    ['a foreign origin', 'GET', { origin: 'https://evil.example' }, false],
    ['Origin: null', 'GET', { origin: 'null' }, false],
    ['cross-site', 'GET', { 'sec-fetch-site': 'cross-site' }, false],
    ['cross-site, upper case', 'GET', { 'sec-fetch-site': 'Cross-Site' }, false],
    ['no-cors (<img>, <script>)', 'GET', { origin: ADMIN, 'sec-fetch-mode': 'no-cors' }, false],
    ['navigate (a link)', 'GET', { 'sec-fetch-mode': 'navigate' }, false],
    ['a repeated Origin', 'GET', { origin: [ADMIN, ADMIN] }, false],
    ['the SPA write', 'POST', { origin: ADMIN, ...csrf }, true],
    ['a PATCH from the SPA', 'PATCH', { origin: ADMIN, ...csrf }, true],
    ['a write without the CSRF header', 'POST', { origin: ADMIN }, false],
    ['a write with a blank CSRF header', 'POST', { origin: ADMIN, [CSRF_HEADER]: '  ' }, false],
    ['a write without Origin', 'POST', { ...csrf }, false],
    ['a write from the web origin', 'POST', { origin: WEB, ...csrf }, false],
    ['a write with two CSRF headers', 'POST', { origin: ADMIN, [CSRF_HEADER]: ['a', 'b'] }, false],
  ])('%s -> %s', (_name, method, headers, allowed) => {
    expect(adminRequestAllowed(req(method, headers), ADMIN)).toBe(allowed);
  });
});

describe('adminRequestAllowed, same-origin read on the production ADMIN_URL (P11-S3)', () => {
  const PROD = 'https://admin.ggpin.uz';
  const read = (host: string | string[], extra: Record<string, string> = {}) =>
    req('GET', {
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      host,
      ...extra,
    });

  it.each<[string, string | string[], Record<string, string>, boolean]>([
    ['the admin host', 'admin.ggpin.uz', {}, true],
    ['the admin host with :443', 'admin.ggpin.uz:443', {}, true],
    ['the admin host in upper case', 'ADMIN.GGPIN.UZ', {}, true],
    ['upper case with :443', 'ADMIN.GGPIN.UZ:443', {}, true],
    ['another port (:8443)', 'admin.ggpin.uz:8443', {}, false],
    ['port :80', 'admin.ggpin.uz:80', {}, false],
    ['the public API host', 'api.ggpin.uz', {}, false],
    ['the store host', 'ggpin.uz', {}, false],
    ['a suffix trick', 'admin.ggpin.uz.evil.example', {}, false],
    ['a trailing dot', 'admin.ggpin.uz.', {}, false],
    // A defence layer only (inject/unit): Node keeps the first Host, Caddy answers 400 to two.
    ['two Host headers', ['admin.ggpin.uz', 'admin.ggpin.uz'], {}, false],
    [
      'X-Forwarded-Host = admin, Host = api',
      'api.ggpin.uz',
      { 'x-forwarded-host': 'admin.ggpin.uz' },
      false,
    ],
    [
      'X-Forwarded-Host = api, Host = admin (never read)',
      'admin.ggpin.uz',
      { 'x-forwarded-host': 'api.ggpin.uz' },
      true,
    ],
    ['Sec-Fetch-Dest: document', 'admin.ggpin.uz', { 'sec-fetch-dest': 'document' }, false],
    [
      'Sec-Fetch-Site: same-site (a page on ggpin.uz)',
      'admin.ggpin.uz',
      { 'sec-fetch-site': 'same-site' },
      false,
    ],
  ])('%s -> %s', (_name, host, extra, allowed) => {
    expect(adminRequestAllowed(read(host, extra), PROD)).toBe(allowed);
  });
});
