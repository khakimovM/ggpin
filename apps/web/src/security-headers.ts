// Security headers for next.config.ts. Pure (no env access) so the rules are unit-tested.

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

const TELEGRAM_SCRIPT = 'https://telegram.org';
const TELEGRAM_FRAME_ANCESTOR = 'https://web.telegram.org';

function csp(kind: 'tg' | 'default', { apiOrigin, isDev }: Options): string {
  // Next.js App Router streams RSC payloads in inline <script> tags, and a static header cannot
  // carry a per-request nonce, so inline scripts stay allowed for now.
  // TODO(phase 7, before S4): nonce + 'strict-dynamic' for /tg and /pay via middleware;
  // landing hash in phase 8.
  const script = [
    "'self'",
    "'unsafe-inline'",
    ...(isDev ? ["'unsafe-eval'"] : []),
    ...(kind === 'tg' ? [TELEGRAM_SCRIPT] : []),
  ];
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', script],
    // Inline styles are needed at runtime: React style props and motion's SSR initial state
    // (attributes), Radix react-style-singleton (Sheet scroll lock), motion popLayout and the
    // Next 404 page (<style> elements). Verified: 'self' alone logs CSP violations.
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

// The three sources never overlap, so no header key is set twice for one response.
export function buildHeaderRules(options: Options): HeaderRule[] {
  return [
    {
      source: '/tg/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp('tg', options) },
        ...common('strict-origin-when-cross-origin', options.isDev),
      ],
    },
    {
      // /pay/<id>?t=<capability token>: the token is in the URL, so it must not leak via Referer.
      source: '/pay/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp('default', options) },
        ...common('no-referrer', options.isDev),
      ],
    },
    {
      source: '/((?!tg(?:/|$)|pay(?:/|$)).*)',
      headers: [
        { key: 'Content-Security-Policy', value: csp('default', options) },
        ...common('strict-origin-when-cross-origin', options.isDev),
      ],
    },
  ];
}
