import { describe, expect, it } from 'vitest';
import { buildCsp, buildHeaderRules, cspKindFor } from './security-headers';

const API_ORIGIN = 'https://api.example.test';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const OPTIONS = { apiOrigin: API_ORIGIN, isDev: false };
const rules = buildHeaderRules({ isDev: false });

// Rules are found by their `source`, never by position.
const TG = '/tg/:path*';
const PAY = '/pay/:path*';
const REST = '/((?!tg(?:/|$)|pay(?:/|$)).*)';

function headerOf(source: string, key: string, list = rules): string {
  const rule = list.find((r) => r.source === source);
  if (!rule) throw new Error(`no rule for ${source}`);
  return rule.headers.find((h) => h.key === key)?.value ?? '';
}

const directive = (policy: string, name: string): string =>
  policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

describe('buildHeaderRules', () => {
  it('has exactly the three non-overlapping sources', () => {
    expect(rules.map((r) => r.source).sort()).toEqual([PAY, REST, TG].sort());
  });

  it('carries a strict fallback CSP with no script source at all (the middleware replaces it)', () => {
    expect(headerOf(TG, 'Content-Security-Policy')).toBe(
      "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors https://web.telegram.org",
    );
    for (const source of [PAY, REST]) {
      expect(headerOf(source, 'Content-Security-Policy')).toBe(
        "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
  });

  it('sends no Referer from /pay because the capability token is in the URL', () => {
    expect(headerOf(PAY, 'Referrer-Policy')).toBe('no-referrer');
    expect(headerOf(TG, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headerOf(REST, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('never caches and never indexes /pay (a card number and an exact amount)', () => {
    expect(headerOf(PAY, 'Cache-Control')).toBe('no-store');
    expect(headerOf(PAY, 'X-Robots-Tag')).toContain('noindex');
    expect(headerOf(TG, 'X-Robots-Tag')).toBe('');
    expect(headerOf(REST, 'X-Robots-Tag')).toBe('');
  });

  it('isolates /pay: no opener handle, no framing, in old browsers too', () => {
    expect(headerOf(PAY, 'Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headerOf(PAY, 'X-Frame-Options')).toBe('DENY');
    expect(headerOf(TG, 'Cross-Origin-Opener-Policy')).toBe('');
    expect(headerOf(REST, 'X-Frame-Options')).toBe('');
  });

  it('sets nosniff and a restrictive Permissions-Policy everywhere', () => {
    for (const r of rules) {
      expect(r.headers.find((h) => h.key === 'X-Content-Type-Options')?.value).toBe('nosniff');
      expect(r.headers.find((h) => h.key === 'Permissions-Policy')?.value).toContain('camera=()');
    }
  });

  it('never repeats a header key within one rule', () => {
    for (const r of rules) {
      const keys = r.headers.map((h) => h.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('sends HSTS everywhere in production and nowhere in development', () => {
    for (const r of rules) {
      expect(r.headers.find((h) => h.key === 'Strict-Transport-Security')?.value).toBe(
        'max-age=63072000; includeSubDomains',
      );
    }
    for (const r of buildHeaderRules({ isDev: true })) {
      expect(r.headers.some((h) => h.key === 'Strict-Transport-Security')).toBe(false);
    }
  });
});

describe('cspKindFor', () => {
  it('treats only /tg and below as the Mini App', () => {
    expect(cspKindFor('/tg')).toBe('tg');
    expect(cspKindFor('/tg/orders/1')).toBe('tg');
    expect(cspKindFor('/tgx')).toBe('default');
    expect(cspKindFor('/ru/tg')).toBe('default');
    expect(cspKindFor('/')).toBe('default');
    expect(cspKindFor('/pay/abc')).toBe('pay');
    expect(cspKindFor('/pay')).toBe('pay');
    expect(cspKindFor('/payx')).toBe('default');
    expect(cspKindFor('/ru/pay/abc')).toBe('default');
  });
});

describe('buildCsp for /pay', () => {
  const pay = buildCsp('pay', NONCE, OPTIONS);

  it('allows images only from itself (no Telegram hosts, no API origin, no blob)', () => {
    expect(directive(pay, 'img-src')).toBe("img-src 'self' data:");
  });

  it('keeps the strict script policy, and no frame may embed it', () => {
    const script = directive(pay, 'script-src');
    expect(script).toContain(`'nonce-${NONCE}'`);
    expect(script).not.toContain('telegram.org');
    expect(script).not.toContain("'unsafe-inline'");
    expect(directive(pay, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(pay, 'connect-src')).toContain(API_ORIGIN);
  });

  it('has no <base> at all', () => {
    expect(directive(pay, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(buildCsp('default', NONCE, OPTIONS), 'base-uri')).toBe("base-uri 'self'");
  });

  it('differs from the default policy only in what images may load and the base URI', () => {
    const normal = buildCsp('default', NONCE, OPTIONS).split('; ');
    const strict = pay.split('; ');
    expect(strict.filter((part) => !normal.includes(part))).toEqual([
      directive(pay, 'img-src'),
      directive(pay, 'base-uri'),
    ]);
  });
});

describe('buildCsp', () => {
  it('puts the nonce and strict-dynamic in script-src, never unsafe-inline', () => {
    for (const kind of ['tg', 'default'] as const) {
      const script = directive(buildCsp(kind, NONCE, OPTIONS), 'script-src');
      expect(script).toContain(`'nonce-${NONCE}'`);
      expect(script).toContain("'strict-dynamic'");
      expect(script).not.toContain("'unsafe-inline'");
      expect(script).not.toContain("'unsafe-eval'");
    }
  });

  it('embeds the nonce it is given, so two requests get two policies', () => {
    const other = 'BBBBBBBBBBBBBBBBBBBBBB==';
    expect(buildCsp('default', other, OPTIONS)).not.toBe(buildCsp('default', NONCE, OPTIONS));
    expect(buildCsp('default', other, OPTIONS)).toContain(`'nonce-${other}'`);
  });

  it('refuses a nonce that could add a directive to the header', () => {
    for (const bad of [
      '',
      'short',
      `${NONCE}; script-src *`,
      "x'y".padEnd(24, 'a'),
      'a b'.padEnd(24, 'a'),
    ]) {
      expect(() => buildCsp('default', bad, OPTIONS)).toThrow();
    }
  });

  it('limits connect-src to self and the API origin', () => {
    expect(directive(buildCsp('default', NONCE, OPTIONS), 'connect-src')).toBe(
      `connect-src 'self' ${API_ORIGIN}`,
    );
  });

  it('allows Telegram Web framing and telegram.org scripts only under /tg', () => {
    const tg = buildCsp('tg', NONCE, OPTIONS);
    expect(directive(tg, 'frame-ancestors')).toBe('frame-ancestors https://web.telegram.org');
    expect(directive(tg, 'script-src')).toContain('https://telegram.org/js/telegram-web-app.js');
    // The SDK file only, not every script of the host.
    expect(directive(tg, 'script-src')).not.toMatch(
      /https:\/\/telegram\.org(?!\/js\/telegram-web-app\.js)/,
    );
    const rest = buildCsp('default', NONCE, OPTIONS);
    expect(directive(rest, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(rest, 'script-src')).not.toContain('telegram.org');
  });

  it('allows inline styles (React/motion/Radix need them) but no remote style sources', () => {
    for (const kind of ['tg', 'default'] as const) {
      expect(directive(buildCsp(kind, NONCE, OPTIONS), 'style-src')).toBe(
        "style-src 'self' 'unsafe-inline'",
      );
    }
  });

  it('allows eval and websockets only in development', () => {
    const dev = buildCsp('default', NONCE, { ...OPTIONS, isDev: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(dev, 'connect-src')).toBe(`connect-src 'self' ${API_ORIGIN} ws:`);
    expect(buildCsp('default', NONCE, OPTIONS)).not.toContain("'unsafe-eval'");
  });
});
