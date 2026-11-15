import { env } from '../env';
import { callSdk, getWebApp } from './webapp';

const SITE = new URL(env.NEXT_PUBLIC_SITE_URL);
const SITE_ORIGIN = SITE.origin;
// docs/04-API-CONTRACT.md (payment pages) and D-39: the Mini App opens the pay page and nothing
// else outside itself.
const PAY_PATH_PREFIX = '/pay/';

/**
 * The URL to open if it is a payment page of OUR site, otherwise null. A relative path resolves
 * against the site origin. Everything is judged on the RESOLVED URL, so `/pay/../login` and
 * `/pay/%2e%2e/login` (both resolve to `/login`) are refused, as are other pages of the site,
 * `blob:` and `data:` URLs (a blob URL reports our origin, so the scheme is compared as well),
 * scheme tricks, protocol-relative `//host`, backslashes and embedded credentials.
 */
export function resolveSiteUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input, SITE_ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== SITE.protocol || url.origin !== SITE_ORIGIN) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!url.pathname.startsWith(PAY_PATH_PREFIX)) return null;
  return url.href;
}

/**
 * Opens a URL already checked by one of the resolvers here outside the Mini App: Telegram's
 * in-app browser, or a new tab in a plain browser.
 */
function openOutside(href: string): boolean {
  const app = getWebApp();
  if (app) {
    // A client that refuses the call (it throws) must not be reported as "opened": the caller then
    // keeps the link for a button press instead of showing a screen that says it is open.
    try {
      app.openLink(href);
    } catch {
      return false;
    }
  } else window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Opens a payment page of OUR site outside the Mini App: Telegram's in-app browser,
 * or a new tab in a plain browser. Anything on another origin is refused and reported with
 * `false`: this function is the only door out of the Mini App for payment links, so it must not
 * become an open redirect.
 */
export function openLink(input: string): boolean {
  const href = resolveSiteUrl(input);
  return href === null ? false : openOutside(href);
}

// The second door (phase 8 S4): the legal texts, linked from the Mini App profile. The site's
// pages refuse to be framed (`frame-ancestors 'none'`), so they open outside the Mini App like the
// pay page. The list is exact paths, written out: no prefix, no pattern, no other page of the
// site (the Mini App has its own help screen, so the FAQ and the contacts are not here).
const MINI_APP_SITE_PAGES: ReadonlySet<string> = new Set([
  '/terms',
  '/ru/terms',
  '/privacy',
  '/ru/privacy',
]);

/**
 * The URL to open if the input is EXACTLY one of the site pages the Mini App may open (a bare path
 * like `/ru/terms`, or our origin followed by it), otherwise null. Nothing is resolved or
 * normalised first: `/terms/`, `/x/../terms`, `/%74erms`, a query, a fragment, another host or
 * scheme and credentials are all simply not on the list.
 */
export function resolveSitePageUrl(input: string): string | null {
  const path = input.startsWith(`${SITE_ORIGIN}/`) ? input.slice(SITE_ORIGIN.length) : input;
  return MINI_APP_SITE_PAGES.has(path) ? `${SITE_ORIGIN}${path}` : null;
}

/** Opens one of those pages outside the Mini App; `false` for anything else or a refusing client. */
export function openSitePage(input: string): boolean {
  const href = resolveSitePageUrl(input);
  return href === null ? false : openOutside(href);
}

const TELEGRAM_ORIGIN = 'https://t.me';

/**
 * The URL if it is a `https://t.me/...` link, otherwise null. Absolute only; `t.me.evil.example`,
 * `t.me@evil.example`, other schemes and ports all end up with another origin or credentials.
 */
export function resolveTelegramUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== TELEGRAM_ORIGIN) return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

/**
 * Opens a t.me link inside Telegram itself (a chat with support, a bot), through the client's own
 * `openTelegramLink`, instead of an external browser. Returns false when the link is not a t.me
 * one or the page is not inside Telegram; the caller then falls back to a plain link.
 */
export function openTelegramUrl(input: string): boolean {
  const href = resolveTelegramUrl(input);
  const app = getWebApp();
  if (href === null || app === null) return false;
  callSdk(() => app.openTelegramLink(href));
  return true;
}
