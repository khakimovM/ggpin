// Security headers. Pure (no env access) so the rules are unit-tested.
//
// Two parts: `buildHeaderRules` is the static set next.config.ts serves, and `buildCsp` is the
// Content-Security-Policy, which the middleware builds per request because script-src carries the
// request's nonce.

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

interface Options {
  /** Origin (scheme + host + port) of the API, e.g. http://localhost:5000. */
  apiOrigin: string;
  /** Dev server needs eval (React refresh) and a websocket for HMR; production does not. */
  isDev: boolean;
}

export type CspKind = 'tg' | 'default';

// Exactly the SDK file, not the whole host: this is only what a browser without 'strict-dynamic'
// can still load.
const TELEGRAM_SCRIPT = 'https://telegram.org/js/telegram-web-app.js';
const TELEGRAM_FRAME_ANCESTOR = 'https://web.telegram.org';

/** The CSP flavour for a request path: only the Mini App may load telegram.org scripts. */
export function cspKindFor(pathname: string): CspKind {
  return /^\/tg(?:\/|$)/.test(pathname) ? 'tg' : 'default';
}

// A nonce is interpolated into a header: anything outside the base64 alphabet could add a
// directive of its own.
const NONCE_VALUE = /^[A-Za-z0-9+/=]{16,}$/;

/**
 * The Content-Security-Policy of one response.
 *
 * script-src: `'nonce-<n>' 'strict-dynamic'` and no 'unsafe-inline'. Next.js stamps the nonce on
 * its own scripts (the inline RSC payload included) when the request carries the same policy, and
 * 'strict-dynamic' lets those scripts load the chunks they need. 'self' and (under /tg) the exact
 * Telegram SDK file stay as the fallback for a browser that ignores 'strict-dynamic'; where it is
 * understood they are ignored, so an injected `<script>` without the nonce does not run.
 */
export function buildCsp(kind: CspKind, nonce: string, { apiOrigin, isDev }: Options): string {
  if (!NONCE_VALUE.test(nonce)) throw new Error('The CSP nonce must be base64.');
  const script = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDev ? ["'unsafe-eval'"] : []),
    ...(kind === 'tg' ? [TELEGRAM_SCRIPT] : []),
  ];
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', script],
    // Inline STYLES stay allowed, unlike scripts: React style props and motion's SSR initial
    // state (attributes), Radix react-style-singleton (Sheet scroll lock), motion popLayout and
    // the Next 404 page (<style> elements) all need them, and a nonce cannot cover style
    // attributes. Verified: 'self' alone logs CSP violations. Injected CSS or HTML can still
    // change what a page looks like (a visual swap); that is not stopped here. The nonce closes the
    // script half of the card-swap threat, and the other half is that no user-controlled HTML is
    // ever rendered unescaped.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', apiOrigin, 'https://t.me', 'https://*.telegram.org']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", apiOrigin, ...(isDev ? ['ws:'] : [])]],
    ['frame-ancestors', kind === 'tg' ? [TELEGRAM_FRAME_ANCESTOR] : ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=()';

const HSTS = 'max-age=63072000; includeSubDomains';

function common(referrer: string, isDev: boolean) {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: referrer },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
    // Browsers ignore HSTS over plain http, but the dev server must never pin localhost.
    ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: HSTS }]),
  ];
}

/**
 * The CSP of a response the middleware did not handle (a path it skips, or an error in it): no
 * script at all, so a page served without its nonce cannot run an injected one. Where the
 * middleware runs, its per-request policy (buildCsp) replaces this header, it is not added to it
 * (verified live in e2e/http.spec.ts: exactly one Content-Security-Policy per response).
 */
export function fallbackCsp(kind: CspKind): string {
  const ancestors = kind === 'tg' ? TELEGRAM_FRAME_ANCESTOR : "'none'";
  return `default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${ancestors}`;
}

// The three sources never overlap, so no header key is set twice for one response.
export function buildHeaderRules({ isDev }: Pick<Options, 'isDev'>): HeaderRule[] {
  const csp = (kind: CspKind) => ({ key: 'Content-Security-Policy', value: fallbackCsp(kind) });
  return [
    {
      source: '/tg/:path*',
      headers: [csp('tg'), ...common('strict-origin-when-cross-origin', isDev)],
    },
    {
      // /pay/<id>#t=<capability token>: a fragment is never sent in a Referer, but the token is a
      // payment capability, so the page also sends no Referer at all, whatever the URL looks like.
      source: '/pay/:path*',
      headers: [csp('default'), ...common('no-referrer', isDev)],
    },
    {
      source: '/((?!tg(?:/|$)|pay(?:/|$)).*)',
      headers: [csp('default'), ...common('strict-origin-when-cross-origin', isDev)],
    },
  ];
}
