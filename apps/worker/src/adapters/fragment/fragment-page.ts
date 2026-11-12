// What we read from a fragment.com page. Fragment has no public API (docs/suppliers/fragment.md):
// the page carries the internal `/api?hash=...` URL, and its markup shows whether the session is
// logged in. Every marker here is a GUESS until the owner's recording confirms it (plan S0b, §7).

export const FRAGMENT_ORIGIN = 'https://fragment.com';
export const FRAGMENT_HOST = 'fragment.com';
/** The Stars purchase page (guess; the public libraries use it). */
export const STARS_PAGE_PATH = '/stars/buy';

export class ForeignHostError extends Error {
  constructor() {
    super('refused: a request or redirect leads outside https://fragment.com');
    this.name = 'ForeignHostError';
  }
}

/** Only `https://fragment.com` (port 443, no credentials); anything else throws. */
export function assertFragmentUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input, FRAGMENT_ORIGIN);
  } catch {
    throw new ForeignHostError();
  }
  const ok =
    url.protocol === 'https:' &&
    url.hostname === FRAGMENT_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === '';
  if (!ok) throw new ForeignHostError();
  return url;
}

/** The internal API hash from the page (JSON-escaped slashes included), or null. */
export function extractApiHash(html: string): string | null {
  const match = /\/api\?hash=([a-fA-F0-9]{6,64})/.exec(html.replace(/\\\//g, '/'));
  return match?.[1] ?? null;
}

/** Candidate login markers (guesses). The recording shows which one tells the two states apart. */
const MARKERS = {
  apiHash: /\\?\/api\?hash=/,
  tgAccountMenu: /tm-menu-tg-account|tm-settings-account/,
  logoutAction: /\blogOut\b|tm-menu-logout|js-logout/i,
  loginButton: /js-header-login|login-link|tm-header-login|>\s*(?:Log in|Connect Telegram)\s*</i,
  tonWallet: /tm-wallet|Wallet\.init\(|tonconnect/i,
  ajInit: /ajInit\(/,
} as const;

export type PageMarkers = { readonly [K in keyof typeof MARKERS]: boolean };

export function detectPageMarkers(html: string): PageMarkers {
  const entries = Object.entries(MARKERS).map(([name, re]) => [name, re.test(html)]);
  return Object.fromEntries(entries) as PageMarkers;
}

/**
 * What a fixture keeps of a page (fix round): the title, the line holding the API URL, and a short
 * snippet around each marker. The full page stays only in the raw folder.
 */
export interface PageExcerpt {
  readonly length: number;
  readonly pageTitle: string | null;
  readonly apiLine: string | null;
  readonly markers: PageMarkers;
  readonly snippets: Readonly<Record<string, string | null>>;
}

const SEPARATOR = /[\s<>"']/;

/**
 * A window around `index`, shrunk at both cut edges to the nearest separator (R-1, N1): a token
 * the window would cut in half is dropped whole, never kept as a fragment.
 */
export function around(html: string, index: number, before: number, after: number): string {
  let start = Math.max(0, index - before);
  let end = Math.min(html.length, index + after);
  if (start > 0) {
    while (start < index && !SEPARATOR.test(html.charAt(start - 1))) start += 1;
  }
  if (end < html.length) {
    while (end > index && !SEPARATOR.test(html.charAt(end))) end -= 1;
  }
  return html.slice(start, end).replace(/\s+/g, ' ');
}

/** The first `max` characters, cut back to the last separator when the cut splits a token. */
export function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  while (end > 0 && !SEPARATOR.test(text.charAt(end))) end -= 1;
  return text.slice(0, end);
}

/** Excerpt of a page that has ALREADY been sanitized as a whole (R-1): never cut a raw page. */
export function pageExcerpt(html: string): PageExcerpt {
  const title = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const api = /\\?\/api\?hash=/.exec(html);
  const snippets: Record<string, string | null> = {};
  for (const [name, re] of Object.entries(MARKERS)) {
    const match = re.exec(html);
    snippets[name] = match === null ? null : around(html, match.index, 80, 120);
  }
  return {
    length: html.length,
    pageTitle: title,
    apiLine: api === null ? null : around(html, api.index, 60, 100),
    markers: detectPageMarkers(html),
    snippets,
  };
}

/** Classes that hold a person's name in Fragment-like markup (guess; R-2, audit KEY4). */
export const NAME_CLASS = String.raw`[a-z0-9-]*(?:account|action|user|peer|profile|header|tg)[a-z0-9-]*-name\b`;

/** Names shown in the page markup (guess), so the sanitizer removes them everywhere. */
export function extractAccountNames(html: string): string[] {
  const names = new Set<string>();
  const re = new RegExp(`class="[^"]*${NAME_CLASS}[^"]*"[^>]*>([^<]{1,128})<`, 'gi');
  for (const match of html.matchAll(re)) {
    const name = match[1]?.trim();
    if (name !== undefined && name !== '') names.add(name);
  }
  return [...names];
}
