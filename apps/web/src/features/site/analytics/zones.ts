import { routing } from '../../../i18n/routing';
import { isTrackedPath } from './tracked-paths';

// The two zones of the web app (phase 8 S5): the marketing pages, which carry the analytics
// tracker, and the private pages (the store, the login, the account pages, the Mini App, the
// payment page), which never may. A link that crosses from one zone to the other is a plain <a>,
// so the browser loads the page anew and the tracker is neither carried in nor left behind (Back
// restores the other zone's own document). SiteLink and PrivateLink both read this one rule.

/** Any URL whose path is read against this base is ours; the host itself is never used. */
const PATH_BASE = 'https://site.invalid';

/** The URL prefix of every locale but the default one (`as-needed`: uz has none). */
const PREFIXES = routing.locales
  .filter((locale) => locale !== routing.defaultLocale)
  .map((locale) => `/${locale}`);

/** The path without its locale prefix: `/ru/store` → `/store`, `/ru` → `/`. */
function unprefixed(pathname: string): string {
  for (const prefix of PREFIXES) {
    if (pathname === prefix) return '/';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  }
  return pathname;
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** The private pages: the store (with its account pages) and the login, in any locale; the Mini
 * App and the payment page, which have no locale prefix. */
function isPrivatePath(pathname: string): boolean {
  if (within(pathname, '/tg') || pathname.startsWith('/pay/')) return true;
  const path = unprefixed(pathname);
  return within(path, '/store') || path === '/login';
}

export type Zone = 'marketing' | 'private' | 'unknown';

/**
 * The zone a link leads into. Only a plain path of our own site has a zone: an outside URL, a
 * protocol-relative or backslash trick (`//x`, `/\x`, which a browser reads as another host) and
 * a relative path are `unknown`, and so is a path of ours that is in neither zone. Every caller
 * treats `unknown` as a zone change (a full page load): the rule fails closed.
 */
export function zoneOf(href: string): Zone {
  if (!href.startsWith('/') || href.startsWith('//')) return 'unknown';
  const url = new URL(href, PATH_BASE);
  if (url.origin !== PATH_BASE) return 'unknown';
  if (isTrackedPath(url.pathname)) return 'marketing';
  return isPrivatePath(url.pathname) ? 'private' : 'unknown';
}
