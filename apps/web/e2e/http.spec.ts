import { expect, test } from '@playwright/test';

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
