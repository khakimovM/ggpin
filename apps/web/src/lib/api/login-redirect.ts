import { DEFAULT_LOCALE, LOCALES } from '@repo/shared';

/**
 * Where to send a visitor whose session is gone: `/[locale]/login?next=<current path>`.
 * Returns null when the visitor already is on the login page (no redirect loop).
 *
 * Only path and query go into `next`, never the hash: a pay link keeps its capability token
 * there. The login page reads `next` back through `safeNextPath`.
 */
export function loginRedirectTarget(pathname: string, search: string): string | null {
  const first = pathname.split('/')[1];
  // The default locale has no URL prefix (`localePrefix: 'as-needed'`).
  const prefixed = LOCALES.find((locale) => locale !== DEFAULT_LOCALE && locale === first);
  const loginPath = prefixed === undefined ? '/login' : `/${prefixed}/login`;
  if (pathname === loginPath || pathname.startsWith(`${loginPath}/`)) return null;
  return `${loginPath}?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

// A throwaway origin: only used to resolve `next` and see whether it would leave the site.
const PROBE_ORIGIN = 'https://site.invalid';
// Written as a loop: a control-character regex trips the `no-control-regex` lint rule.
function hasControlOrBackslash(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '\\') return true;
  }
  return false;
}
// The login pages of every locale, built from LOCALES so a new locale cannot be forgotten.
const LOGIN_PATH = new RegExp(`^/(?:(?:${LOCALES.join('|')})/)?login(?:/|$)`, 'i');

function isSafeLocalPath(value: string): boolean {
  // One leading slash, not followed by another slash or a backslash (`//host` and `/\host` are
  // protocol-relative URLs to a browser).
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  return !hasControlOrBackslash(value);
}

/**
 * The `next` query value of the login page, reduced to a same-origin path (`pathname + search`)
 * or `fallback`. Everything that could leave the site, or bounce back into the login page, is
 * refused: absolute and protocol-relative URLs, backslashes, control characters (browsers strip
 * tabs and newlines inside URLs, turning `/<TAB>/evil` into `//evil`), `javascript:`, and the
 * same tricks hidden behind percent-encoding.
 *
 * The URL parser also resolves dot segments, which can turn a harmless-looking input into a
 * protocol-relative one (`/.//evil.com`, `/a/..//evil.com`, `/%2e//evil.com` all resolve to
 * `//evil.com`). So the safety checks run again on the RESOLVED result, not only on the input.
 */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  if (typeof next !== 'string' || next === '') return fallback;
  if (!isSafeLocalPath(next) || !isSafeWhenDecoded(next)) return fallback;

  const url = new URL(next, PROBE_ORIGIN);
  if (url.origin !== PROBE_ORIGIN) return fallback;

  const resolved = `${url.pathname}${url.search}`;
  if (!isSafeLocalPath(resolved) || !isSafeWhenDecoded(resolved)) return fallback;

  // The login page itself, in any locale, however it is spelled (`/%6Cogin`).
  const decodedPath = decodeOrNull(url.pathname);
  if (decodedPath === null) return fallback;
  if (LOGIN_PATH.test(url.pathname) || LOGIN_PATH.test(decodedPath)) return fallback;
  return resolved;
}

function decodeOrNull(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// `/%2F%2Fevil.com` is a harmless path today, but anything that decodes into an unsafe shape is
// one bad decode away from being an open redirect. The decoded text is also resolved the way the
// URL parser would (dot segments included): `/%2e%2e%2f%2fevil.com` decodes to `/..//evil.com`,
// which resolves to `//evil.com`.
function isSafeWhenDecoded(value: string): boolean {
  const decoded = decodeOrNull(value);
  if (decoded === null || !isSafeLocalPath(decoded)) return false;
  const resolved = new URL(decoded, PROBE_ORIGIN);
  return (
    resolved.origin === PROBE_ORIGIN && isSafeLocalPath(`${resolved.pathname}${resolved.search}`)
  );
}
