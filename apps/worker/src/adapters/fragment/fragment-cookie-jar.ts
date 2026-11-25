import { FRAGMENT_HOST } from './fragment-page';

// The Fragment session's cookie jar (phase 5 S7, docs/06 "Fragment sessiyasi"): what the browser
// keeps for fragment.com, plus the page's internal API `hash`. It lives in memory only while a
// request runs; at rest it is the AES-256-GCM blob in FragmentSession.cookiesEnc
// (fragment-session.store.ts). No function here logs or throws a value: errors say what was
// wrong, never with what.

/** RFC 6265 token characters, short: the cookie names Fragment uses are `stel_*` (guess, S0b). */
const COOKIE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** RFC 6265 cookie-octets (no space, quote, comma, semicolon or backslash), bounded. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/;
/** More than a browser session of one site ever needs; a jar never grows past it. */
export const MAX_COOKIES = 32;
const PAGE_HASH = /^[a-fA-F0-9]{6,64}$/;

export interface FragmentJar {
  readonly cookies: ReadonlyMap<string, string>;
  /** The page's `/api?hash=...` value (extractApiHash), once a logged-in page has shown it. */
  readonly pageHash: string | null;
}

export class CookieInputError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CookieInputError';
  }
}

export function isCookieName(name: string): boolean {
  return COOKIE_NAME.test(name);
}

export function isCookieValue(value: string): boolean {
  return COOKIE_VALUE.test(value);
}

export function isPageHash(value: string): boolean {
  return PAGE_HASH.test(value);
}

/** The `Cookie` request header of the jar ('' for an empty jar). */
export function cookieHeader(jar: FragmentJar): string {
  return [...jar.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function expiredBy(attributes: readonly string[], nowMs: number): boolean {
  for (const attribute of attributes) {
    const eq = attribute.indexOf('=');
    const key = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : attribute.slice(eq + 1).trim();
    if (key === 'max-age' && /^-?\d+$/.test(value) && Number(value) <= 0) return true;
    if (key === 'expires') {
      const at = Date.parse(value);
      if (!Number.isNaN(at) && at <= nowMs) return true;
    }
  }
  return false;
}

/**
 * A `Domain` attribute that is not exactly fragment.com (`.fragment.com` is the same): the line
 * is ignored (audit I-4). A subdomain is refused too: the jar is sent to fragment.com only, and a
 * cookie scoped to another host there is not one this session needs.
 */
function foreignDomain(attributes: readonly string[]): boolean {
  for (const attribute of attributes) {
    const eq = attribute.indexOf('=');
    if (eq < 0 || attribute.slice(0, eq).trim().toLowerCase() !== 'domain') continue;
    const domain = attribute
      .slice(eq + 1)
      .trim()
      .toLowerCase()
      .replace(/^\./, '');
    if (domain !== FRAGMENT_HOST) return true;
  }
  return false;
}

/**
 * The jar after fragment.com's `Set-Cookie` lines: a cookie is set, replaced or (expired, empty,
 * `deleted`) removed. A line with another domain, a malformed name or value, or a new name past
 * MAX_COOKIES is ignored. `changed`: the jar must be stored again.
 */
export function applySetCookies(
  jar: FragmentJar,
  lines: readonly string[],
  nowMs: number = Date.now(),
): { readonly jar: FragmentJar; readonly changed: boolean } {
  const cookies = new Map(jar.cookies);
  let changed = false;
  for (const line of lines) {
    const [pair = '', ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0 || foreignDomain(attributes)) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!isCookieName(name)) continue;
    if (expiredBy(attributes, nowMs) || value === '' || value === 'deleted') {
      changed = cookies.delete(name) || changed;
      continue;
    }
    if (!isCookieValue(value)) continue;
    if (!cookies.has(name) && cookies.size >= MAX_COOKIES) continue;
    if (cookies.get(name) === value) continue;
    cookies.set(name, value);
    changed = true;
  }
  return { jar: changed ? { cookies, pageHash: jar.pageHash } : jar, changed };
}

/**
 * The cookies the owner pastes into the import CLI (Q9): `name=value` per line, or a browser
 * `Cookie:` header (`a=1; b=2`, with or without the `Cookie:` prefix). Blank lines and `#`
 * comments are skipped. Throws CookieInputError naming the line NUMBER, never its content.
 */
export function parseCookieInput(text: string): Map<string, string> {
  const cookies = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim().replace(/^cookie:\s*/i, '');
    if (line === '' || line.startsWith('#')) return;
    for (const part of line.split(';')) {
      const pair = part.trim();
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const name = eq <= 0 ? '' : pair.slice(0, eq).trim();
      const value = eq <= 0 ? '' : pair.slice(eq + 1).trim();
      if (!isCookieName(name) || !isCookieValue(value)) {
        throw new CookieInputError(`line ${String(index + 1)}: not a name=value cookie`);
      }
      cookies.set(name, value);
    }
  });
  if (cookies.size === 0) throw new CookieInputError('no cookie was given');
  if (cookies.size > MAX_COOKIES) {
    throw new CookieInputError(`more than ${String(MAX_COOKIES)} cookies`);
  }
  return cookies;
}
