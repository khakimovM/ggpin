import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { createNonce, NONCE_HEADER } from './csp/nonce';
import { env } from './env';
import { PAY_LOCALE_HEADER, payLocaleFromEntries } from './features/pay/pay-locale';
import { routing } from './i18n/routing';
import { buildCsp, cspKindFor } from './security-headers';

const handleLocaleRouting = createIntlMiddleware(routing);

const apiOrigin = new URL(env.NEXT_PUBLIC_API_URL).origin;
const isDev = process.env.NODE_ENV !== 'production';

// /tg (Mini App: locale comes from the user profile), /pay (locale from ?locale=) and /dev
// (component gallery) have no locale prefix, so they skip the locale routing. They still get the
// nonce and the CSP below.
const NO_LOCALE_PREFIX = /^\/(?:tg|pay|dev)(?:\/|$)/;

/**
 * One middleware for two jobs: the per-request CSP nonce (every page) and the locale routing
 * (the pages that have a locale in the URL).
 *
 * The nonce travels two ways. The `Content-Security-Policy` REQUEST header is what Next.js reads
 * to stamp the nonce on its own inline and chunk scripts; `x-nonce` is for our server components
 * (the theme script). Both are `set`, never forwarded, so a client cannot supply its own. The
 * policy is also sent as the RESPONSE header, which is the one the browser enforces.
 */
export default function middleware(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const policy = buildCsp(cspKindFor(request.nextUrl.pathname), nonce, { apiOrigin, isDev });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  // /pay has no locale prefix: its language is `?locale=`, handed on for the root layout's `lang`.
  if (cspKindFor(request.nextUrl.pathname) === 'pay') {
    requestHeaders.set(
      PAY_LOCALE_HEADER,
      payLocaleFromEntries([...request.nextUrl.searchParams.entries()]),
    );
  }

  const response = NO_LOCALE_PREFIX.test(request.nextUrl.pathname)
    ? NextResponse.next({ request: { headers: requestHeaders } })
    : handleLocaleRouting(new NextRequest(request, { headers: requestHeaders }));

  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  // Skipped: API routes (a whole segment, so `/apiary` is a page), Next internals, and files with a
  // known STATIC extension. A path that merely contains a dot (`/ru/a.b`, `/tg/a.b`) is a page
  // like any other and must get its nonce and CSP. The skipped paths that do reach the server get
  // the strict fallback CSP from next.config (see buildHeaderRules).
  matcher: [
    '/((?!api(?:/|$)|_next(?:/|$)|_vercel(?:/|$)|.*\\.(?:ico|png|jpe?g|gif|svg|webp|avif|txt|xml|webmanifest|json|map|js|css|woff2?)$).*)',
  ],
};
