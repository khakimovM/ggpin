import { expect, test, type APIResponse } from '@playwright/test';

// Protocol-level checks (no browser rendering), run once in the `http` project.
test.describe('security headers', () => {
  test('/ forbids framing, limits connect-src and sets the common headers', async ({ request }) => {
    const headers = (await request.get('/')).headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' http://localhost:5000");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  });

  test('/tg may be framed by Telegram Web and loads telegram.org scripts', async ({ request }) => {
    const csp = (await request.get('/tg')).headers()['content-security-policy'] ?? '';
    expect(csp).toContain('frame-ancestors https://web.telegram.org');
    expect(csp).toMatch(/script-src [^;]*https:\/\/telegram\.org/);
  });

  test('/pay sends no Referer (capability token in the URL), even before the page exists', async ({
    request,
  }) => {
    const headers = (await request.get('/pay/some-intent?t=token')).headers();
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  test('/ru carries the same CSP as /', async ({ request }) => {
    const csp = (await request.get('/ru')).headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

test.describe('locale routing', () => {
  test('/uz redirects to the unprefixed default', async ({ request }) => {
    const response = await request.get('/uz', { maxRedirects: 0 });
    expect([307, 308]).toContain(response.status());
    expect(new URL(response.headers().location ?? '', 'http://localhost').pathname).toBe('/');
  });

  test('Accept-Language does not redirect: uz stays the default (docs/08)', async ({ request }) => {
    const response = await request.get('/', {
      headers: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('<html lang="uz"');
  });
});

// ---- Nonce CSP (phase 7 X4) --------------------------------------------------------------------
// Every page is rendered per request with its own nonce; no script source allows 'unsafe-inline'.
// Unmatched URLs are included on purpose: Next serves a prerendered 404 for them unless a
// catch-all page renders it, and a prerendered page cannot carry a nonce.
const NONCE_PATHS = [
  '/',
  '/ru',
  '/login',
  '/ru/login',
  '/store',
  '/store/profile',
  '/tg',
  '/nonexistent',
  '/ru/nonexistent',
  '/tg/nonexistent',
  '/pay/some-intent',
];

function scriptSrc(csp: string): string {
  return csp.split('; ').find((part) => part.startsWith('script-src ')) ?? '';
}

function nonceOf(csp: string): string {
  return /'nonce-([^']+)'/.exec(scriptSrc(csp))?.[1] ?? '';
}

async function pageAndPolicy(response: APIResponse) {
  const csp = response.headers()['content-security-policy'] ?? '';
  return { csp, html: await response.text() };
}

test.describe('nonce CSP', () => {
  for (const path of NONCE_PATHS) {
    test(`${path}: no unsafe-inline, and every script carries this response's nonce`, async ({
      request,
    }) => {
      const { csp, html } = await pageAndPolicy(await request.get(path));
      const nonce = nonceOf(csp);
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(scriptSrc(csp)).toContain("'strict-dynamic'");
      expect(scriptSrc(csp)).not.toContain("'unsafe-inline'");
      expect(scriptSrc(csp)).not.toContain("'unsafe-eval'");

      const tags = html.match(/<script\b[^>]*>/g) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
      // Preloads are fetched under script-src too.
      for (const tag of html.match(/<link\b[^>]*rel="preload"[^>]*as="script"[^>]*>/g) ?? []) {
        expect(tag).toContain(`nonce="${nonce}"`);
      }
    });
  }

  test('the nonce is different on every request, also for the same URL', async ({ request }) => {
    const nonces = new Set<string>();
    for (const path of ['/', '/', '/', '/ru', '/tg', '/tg']) {
      nonces.add(nonceOf((await request.get(path)).headers()['content-security-policy'] ?? ''));
    }
    expect(nonces.size).toBe(6);
  });

  test('a nonce sent by the client is never used', async ({ request }) => {
    const sent = 'AAAAAAAAAAAAAAAAAAAAAA==';
    const response = await request.get('/', {
      headers: { 'x-nonce': sent, 'content-security-policy': "script-src 'unsafe-inline'" },
    });
    const { csp, html } = await pageAndPolicy(response);
    expect(nonceOf(csp)).not.toBe(sent);
    expect(html).not.toContain(sent);
  });

  test('pages are never cached with a nonce in them', async ({ request }) => {
    for (const path of ['/', '/tg', '/login']) {
      const cache = (await request.get(path)).headers()['cache-control'] ?? '';
      expect(cache).toContain('no-store');
    }
  });

  test('static files get the strict fallback CSP: no script allowed at all', async ({
    request,
  }) => {
    const html = await (await request.get('/')).text();
    const asset = /src="(\/_next\/static\/[^"]+\.js)"/.exec(html)?.[1];
    expect(asset).toBeTruthy();
    const response = await request.get(asset ?? '/');
    expect(response.status()).toBe(200);
    const policies = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'content-security-policy');
    expect(policies.map((h) => h.value)).toEqual([
      "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ]);
  });

  test('a page has exactly ONE CSP header, the nonce one (the config fallback is replaced, not added)', async ({
    request,
  }) => {
    for (const path of ['/', '/ru', '/tg', '/login', '/nonexistent']) {
      const response = await request.get(path);
      const policies = response
        .headersArray()
        .filter((header) => header.name.toLowerCase() === 'content-security-policy');
      expect(policies, path).toHaveLength(1);
      expect(nonceOf(policies[0]?.value ?? ''), path).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    }
  });

  // A dot in a path does not make it a static file: these are ordinary (404) pages and must get
  // their nonce and CSP, with the frame-ancestors of their area. `/apiary` and `/apix` only start
  // with "api"; they are not the API.
  for (const [path, ancestors] of [
    ['/tg/a.b', 'frame-ancestors https://web.telegram.org'],
    ['/ru/a.b', "frame-ancestors 'none'"],
    ['/a.b', "frame-ancestors 'none'"],
    ['/apiary', "frame-ancestors 'none'"],
    ['/apix', "frame-ancestors 'none'"],
  ] as const) {
    test(`${path} is a page: one nonce CSP with ${ancestors}`, async ({ request }) => {
      const response = await request.get(path);
      const policies = response
        .headersArray()
        .filter((header) => header.name.toLowerCase() === 'content-security-policy');
      expect(policies).toHaveLength(1);
      const csp = policies[0]?.value ?? '';
      expect(nonceOf(csp)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(scriptSrc(csp)).not.toContain("'unsafe-inline'");
      expect(csp).toContain(ancestors);
    });
  }

  test('the API path (skipped by the middleware) still gets the strict fallback CSP', async ({
    request,
  }) => {
    for (const path of ['/api/x', '/api']) {
      const policies = (await request.get(path))
        .headersArray()
        .filter((header) => header.name.toLowerCase() === 'content-security-policy');
      expect(
        policies.map((h) => h.value),
        path,
      ).toEqual([
        "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      ]);
    }
  });
});
