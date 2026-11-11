// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { NONCE_PATTERN } from './csp/nonce';
import middleware, { config } from './middleware';

const call = (path: string, headers: Record<string, string> = {}) =>
  middleware(new NextRequest(`http://localhost:3000${path}`, { headers }));

const nonceOf = (policy: string | null): string | undefined =>
  /'nonce-([^']+)'/.exec(policy ?? '')?.[1];

// Next hands the (possibly changed) request headers on to the page through these response headers.
const forwarded = (response: Response, name: string) =>
  response.headers.get(`x-middleware-request-${name}`);

describe('middleware CSP', () => {
  it.each(['/', '/ru', '/store/profile', '/tg', '/tg/orders/1', '/pay/abc', '/dev/ui'])(
    '%s gets a policy with a fresh nonce and no unsafe-inline script source',
    (path) => {
      const response = call(path);
      const policy = response.headers.get('content-security-policy');
      const script = policy?.split('; ').find((d) => d.startsWith('script-src ')) ?? '';
      expect(nonceOf(policy)).toMatch(NONCE_PATTERN);
      expect(script).toContain("'strict-dynamic'");
      expect(script).not.toContain("'unsafe-inline'");
    },
  );

  it('uses a different nonce per request', () => {
    const nonces = new Set(
      Array.from({ length: 50 }, () => nonceOf(call('/').headers.get('content-security-policy'))),
    );
    expect(nonces.size).toBe(50);
  });

  it('hands the same nonce and policy to the page through the request headers', () => {
    const response = call('/ru/store');
    const policy = response.headers.get('content-security-policy');
    expect(forwarded(response, 'content-security-policy')).toBe(policy);
    expect(forwarded(response, 'x-nonce')).toBe(nonceOf(policy));
  });

  it('ignores a nonce or policy supplied by the client', () => {
    const response = call('/', {
      'x-nonce': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'content-security-policy': "script-src 'unsafe-inline'",
    });
    const policy = response.headers.get('content-security-policy');
    expect(nonceOf(policy)).not.toBe('AAAAAAAAAAAAAAAAAAAAAA==');
    expect(forwarded(response, 'x-nonce')).toBe(nonceOf(policy));
    expect(forwarded(response, 'content-security-policy')).toBe(policy);
  });

  it('only /tg may frame into Telegram Web and load telegram.org scripts', () => {
    expect(call('/tg').headers.get('content-security-policy')).toContain(
      'frame-ancestors https://web.telegram.org',
    );
    expect(call('/').headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(call('/pay/x').headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
  });
});

describe('middleware locale routing', () => {
  it('rewrites the default locale internally and keeps the ru prefix', () => {
    expect(call('/').headers.get('x-middleware-rewrite')).toContain('/uz');
    expect(call('/ru/store').headers.get('x-middleware-rewrite')).toBeNull();
    expect(call('/uz', {}).status).toBe(307);
  });

  it('leaves /tg, /pay and /dev without a locale prefix', () => {
    for (const path of ['/tg', '/tg/home', '/pay/abc', '/dev/ui']) {
      expect(call(path).headers.get('x-middleware-rewrite')).toBeNull();
    }
  });

  it('bypasses only the API, Next internals and files with a static extension', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    for (const path of [
      '/api',
      '/api/x',
      '/_next/static/a.js',
      '/_next/image',
      '/_vercel/x',
      '/favicon.ico',
      '/robots.txt',
      '/sitemap.xml',
      '/fonts/a.woff2',
      '/a/b.css',
    ]) {
      expect(pattern.test(path), path).toBe(false);
    }
  });

  it('serves every other path through the middleware, a dot in it or not', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    for (const path of [
      '/',
      '/ru',
      '/tg',
      '/pay/abc',
      '/login',
      '/tg/a.b',
      '/ru/a.b',
      '/a.b',
      '/apiary',
      '/apix',
      '/api-docs',
      '/_nextfoo',
      '/x.html',
      '/x.php',
    ]) {
      expect(pattern.test(path), path).toBe(true);
    }
  });

  it('a dotted page path still gets the nonce and the CSP (it is not a static file)', () => {
    for (const path of ['/tg/a.b', '/ru/a.b', '/apiary', '/apix']) {
      const policy = call(path).headers.get('content-security-policy');
      expect(nonceOf(policy), path).toMatch(NONCE_PATTERN);
    }
  });
});
