import { describe, expect, it } from 'vitest';
import { buildHeaderRules } from './security-headers';

const API_ORIGIN = 'https://api.example.test';
const rules = buildHeaderRules({ apiOrigin: API_ORIGIN, isDev: false });

// Rules are found by their `source`, never by position.
const TG = '/tg/:path*';
const PAY = '/pay/:path*';
const REST = '/((?!tg(?:/|$)|pay(?:/|$)).*)';

function headerOf(source: string, key: string, list = rules): string {
  const rule = list.find((r) => r.source === source);
  if (!rule) throw new Error(`no rule for ${source}`);
  return rule.headers.find((h) => h.key === key)?.value ?? '';
}
const csp = (source: string, list = rules) => headerOf(source, 'Content-Security-Policy', list);

describe('buildHeaderRules', () => {
  it('has exactly the three non-overlapping sources', () => {
    expect(rules.map((r) => r.source).sort()).toEqual([PAY, REST, TG].sort());
  });

  it('limits connect-src to self and the API origin', () => {
    expect(csp(REST)).toContain(`connect-src 'self' ${API_ORIGIN};`);
  });

  it('allows Telegram Web framing and telegram.org scripts only under /tg', () => {
    expect(csp(TG)).toContain('frame-ancestors https://web.telegram.org');
    expect(csp(TG)).toMatch(/script-src [^;]*https:\/\/telegram\.org/);
    for (const source of [PAY, REST]) {
      expect(csp(source)).toContain("frame-ancestors 'none'");
      expect(csp(source)).not.toMatch(/script-src [^;]*telegram\.org/);
    }
  });

  it('sends no Referer from /pay because the capability token is in the URL', () => {
    expect(headerOf(PAY, 'Referrer-Policy')).toBe('no-referrer');
    expect(headerOf(TG, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headerOf(REST, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
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

  it('allows inline styles (React/motion/Radix need them) but no remote style sources', () => {
    for (const source of [TG, PAY, REST]) {
      expect(csp(source)).toContain("style-src 'self' 'unsafe-inline';");
    }
  });

  it('sends HSTS everywhere in production', () => {
    for (const r of rules) {
      expect(r.headers.find((h) => h.key === 'Strict-Transport-Security')?.value).toBe(
        'max-age=63072000; includeSubDomains',
      );
    }
  });

  it('allows eval and websockets, and omits HSTS, only in development', () => {
    const dev = buildHeaderRules({ apiOrigin: API_ORIGIN, isDev: true });
    expect(csp(REST, dev)).toContain("'unsafe-eval'");
    expect(csp(REST, dev)).toContain("connect-src 'self' https://api.example.test ws:");
    expect(csp(REST)).not.toContain("'unsafe-eval'");
    for (const r of dev) {
      expect(r.headers.some((h) => h.key === 'Strict-Transport-Security')).toBe(false);
    }
  });
});
