import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../env';
import { openLink, openTelegramUrl, resolveSiteUrl, resolveTelegramUrl } from '../open-link';
import { createFakeWebApp, installWebApp } from './fake-webapp';

const SITE = env.NEXT_PUBLIC_SITE_URL;
// Built with the URL API, not written as a literal: a literal with credentials trips secret scanners.
function withCredentials(username: string, password: string, path = '/pay/abc'): string {
  const url = new URL(path, SITE);
  url.username = username;
  url.password = password;
  return url.href;
}

describe('resolveSiteUrl (payment pages of our own site only)', () => {
  it.each([
    [`${SITE}/pay/abc#t=x`, `${SITE}/pay/abc#t=x`],
    [`${SITE}/pay/abc?locale=uz#t=x`, `${SITE}/pay/abc?locale=uz#t=x`],
    ['/pay/abc', `${SITE}/pay/abc`],
    ['/pay/abc?locale=ru', `${SITE}/pay/abc?locale=ru`],
  ])('accepts %s', (input, expected) => {
    expect(resolveSiteUrl(input)).toBe(expected);
  });

  it.each([
    ['another page of our site', `${SITE}/ru/store`],
    ['the home page', `${SITE}/`],
    ['the login page', `${SITE}/login`],
    ['a path that only starts like it', `${SITE}/payment/abc`],
    ['a dot-segment walk out of /pay/', '/pay/../login'],
    ['the same, percent-encoded', '/pay/%2e%2e/login'],
    ['the same, mixed', '/pay/.%2e/login'],
    ['the same, absolute', `${SITE}/pay/../ru/store`],
    ['a blob: URL that reports our origin', `blob:${SITE}/pay/abc`],
    ['a data: URL', 'data:text/html,<script>1</script>'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['another origin', 'https://evil.example/pay/abc'],
    ['protocol-relative', '//evil.example/pay/abc'],
    ['a backslash host', '/\\evil.example/pay/abc'],
    ['two backslashes', '\\\\evil.example'],
    ['Telegram', 'https://t.me/ggpin_bot'],
    ['a host that starts with ours', `${SITE}.evil.example/pay/abc`],
    ['our origin with a user name', withCredentials('name', '')],
    ['our origin with credentials', withCredentials('name', 'secret-value')],
    ['an unparsable URL', 'http://[::1'],
  ])('refuses %s', (_label, input) => {
    expect(resolveSiteUrl(input)).toBeNull();
  });
});

describe('openLink', () => {
  afterEach(() => {
    delete window.Telegram;
    vi.restoreAllMocks();
  });

  it('opens a payment page through Telegram inside the Mini App', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    expect(openLink('/pay/abc')).toBe(true);
    expect(app.openLink).toHaveBeenCalledExactlyOnceWith(`${SITE}/pay/abc`);
  });

  it('opens a new tab outside Telegram', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openLink('/pay/abc')).toBe(true);
    expect(open).toHaveBeenCalledWith(`${SITE}/pay/abc`, '_blank', 'noopener,noreferrer');
  });

  it('opens nothing else: other origins, other pages of the site, walks out of /pay/', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    for (const input of [
      'https://evil.example/',
      '//evil.example/',
      `${SITE}/ru/store`,
      '/pay/../login',
      '/pay/%2e%2e/login',
    ]) {
      expect(openLink(input), input).toBe(false);
    }
    expect(app.openLink).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('resolveTelegramUrl', () => {
  it.each(['https://t.me/ggpin_support', 'https://t.me/ggpin_bot?start=ref_abc12345'])(
    'accepts %s',
    (input) => {
      expect(resolveTelegramUrl(input)).toBe(input);
    },
  );

  it.each([
    ['http, not https', 'http://t.me/ggpin_support'],
    ['a look-alike host', 'https://t.me.evil.example/x'],
    ['user info that hides the host', 'https://t.me@evil.example/x'],
    ['a port', 'https://t.me:8443/x'],
    ['another Telegram host', 'https://telegram.me/x'],
    ['a relative path', '/ggpin_support'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['our own site', `${SITE}/pay/abc`],
  ])('refuses %s', (_label, input) => {
    expect(resolveTelegramUrl(input)).toBeNull();
  });
});

describe('openTelegramUrl', () => {
  afterEach(() => {
    delete window.Telegram;
  });

  it('opens a t.me link through the Telegram client', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    expect(openTelegramUrl('https://t.me/ggpin_support')).toBe(true);
    expect(app.openTelegramLink).toHaveBeenCalledExactlyOnceWith('https://t.me/ggpin_support');
    expect(app.openLink).not.toHaveBeenCalled();
  });

  it('refuses anything that is not a t.me link, and does nothing outside Telegram', () => {
    const app = createFakeWebApp();
    installWebApp(app);
    expect(openTelegramUrl('https://evil.example/x')).toBe(false);
    expect(app.openTelegramLink).not.toHaveBeenCalled();
    delete window.Telegram;
    expect(openTelegramUrl('https://t.me/ggpin_support')).toBe(false);
  });
});
