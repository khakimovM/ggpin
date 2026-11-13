import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../env';
import { openLink, openSitePage, resolveSitePageUrl, resolveSiteUrl } from '../open-link';
import { createFakeWebApp, installWebApp } from './fake-webapp';

// The Mini App's second door out (phase 8 S4): the legal pages of the site, by exact path only.
// The first door (payment pages, open-link.test.ts) does not change.

const SITE = new URL(env.NEXT_PUBLIC_SITE_URL).origin;
const ALLOWED = ['/terms', '/ru/terms', '/privacy', '/ru/privacy'] as const;

// Built with the URL API, not written as a literal: a literal with credentials trips secret scanners.
function withCredentials(path: string): string {
  const url = new URL(path, SITE);
  url.username = 'name';
  url.password = 'secret-value';
  return url.href;
}

describe('resolveSitePageUrl (the legal pages, exact paths only)', () => {
  it.each(ALLOWED)('accepts %s, as a path and as a URL of our site', (path) => {
    expect(resolveSitePageUrl(path)).toBe(`${SITE}${path}`);
    expect(resolveSitePageUrl(`${SITE}${path}`)).toBe(`${SITE}${path}`);
  });

  it.each([
    ['another page of the site', '/faq'],
    ['the contacts', '/ru/contacts'],
    ['the home page', '/'],
    ['the store', '/store'],
    ['a payment page', '/pay/abc'],
    ['an Uzbek prefix the site does not use', '/uz/terms'],
    ['a trailing slash', '/terms/'],
    ['another case', '/TERMS'],
    ['a walk out of the page', '/terms/../pay'],
    ['a walk that would land on the page', '/x/../terms'],
    ['a percent-encoded letter', '/%74erms'],
    ['a percent-encoded walk', '/terms/%2e%2e/pay/abc'],
    ['a query', '/terms?next=/pay/abc'],
    ['an empty query', '/terms?'],
    ['a fragment', '/ru/privacy#t=x'],
    ['an empty fragment', '/privacy#'],
    ['a query on the full URL', `${SITE}/terms?utm_source=x`],
    ['a space before', ' /terms'],
    ['a space after', '/terms '],
    ['a backslash', '\\terms'],
    ['a doubled slash after our origin', `${SITE}//terms`],
    ['protocol-relative', '//evil.example/terms'],
    ['another origin', 'https://evil.example/terms'],
    ['a host that starts with ours', `${SITE}.evil.example/terms`],
    ['our origin as a user name', `${SITE}@evil.example/terms`],
    ['credentials on our origin', withCredentials('/terms')],
    ['a blob: URL that reports our origin', `blob:${SITE}/terms`],
    ['a javascript: URL', 'javascript:alert(1)//terms'],
    ['a data: URL', 'data:text/html,/terms'],
    ['Telegram', 'https://t.me/terms'],
    ['an empty string', ''],
  ])('refuses %s', (_label, input) => {
    expect(resolveSitePageUrl(input)).toBeNull();
  });

  it('the payment door still refuses the legal pages, and this door refuses payment pages', () => {
    for (const path of ALLOWED) expect(resolveSiteUrl(path)).toBeNull();
    expect(resolveSitePageUrl('/pay/abc')).toBeNull();
  });
});

describe('openSitePage', () => {
  afterEach(() => {
    delete window.Telegram;
    vi.restoreAllMocks();
  });

  it('opens a legal page through Telegram inside the Mini App', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    expect(openSitePage('/ru/terms')).toBe(true);
    expect(app.openLink).toHaveBeenCalledExactlyOnceWith(`${SITE}/ru/terms`);
  });

  it('opens a new tab without an opener outside Telegram', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openSitePage('/privacy')).toBe(true);
    expect(open).toHaveBeenCalledWith(`${SITE}/privacy`, '_blank', 'noopener,noreferrer');
  });

  it('opens nothing that is not on the list, inside Telegram or outside it', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    for (const input of ['/faq', '/terms/../pay', '//evil.example/terms', '/terms?x=1', '/pay/a']) {
      expect(openSitePage(input), input).toBe(false);
    }
    expect(app.openLink).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('reports a client that refuses the call as not opened', () => {
    const app = createFakeWebApp();
    vi.mocked(app.openLink).mockImplementation(() => {
      throw new Error('WebAppMethodUnsupported');
    });
    installWebApp(app);
    expect(openSitePage('/terms')).toBe(false);
  });

  it('openLink (the payment door) does not open a legal page', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    expect(openLink('/terms')).toBe(false);
    expect(app.openLink).not.toHaveBeenCalled();
  });
});
