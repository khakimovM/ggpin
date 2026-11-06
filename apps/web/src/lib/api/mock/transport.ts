// Development-only transport that answers from fixtures. It is imported dynamically from
// client.ts behind a `NODE_ENV !== 'production'` check, so it is not part of a production build.
import { CSRF_HEADER, DEFAULT_LOCALE, LOCALES, type Locale } from '@repo/shared';
import { env } from '../../../env';
import type { Transport, TransportRequest, TransportResponse } from '../transport';
import { ordersRoutes } from './handlers/orders';
import { paymentsRoutes } from './handlers/payments';
import { quotesRoutes } from './handlers/quotes';
import { recipientsRoutes } from './handlers/recipients';
import { referralsRoutes } from './handlers/referrals';
import { walletRoutes } from './handlers/wallet';
import {
  fail,
  matchRoute,
  toScenario,
  type MockReply,
  type MockRoute,
  type MockScenario,
} from './router';

const ROUTES: readonly MockRoute[] = [
  ...walletRoutes,
  ...paymentsRoutes,
  ...quotesRoutes,
  ...recipientsRoutes,
  ...ordersRoutes,
  ...referralsRoutes,
];

export interface MockTransportOptions {
  apiBaseUrl: string;
  siteUrl: string;
  /** Simulated latency, so skeletons are visible while developing. */
  delayMs?: number;
  /** Picks the scenario for a request; the default reads `?mock=<name>` from the page URL. */
  getScenario?: () => MockScenario | undefined;
  /** The page language; the default reads `<html lang>`. */
  getLocale?: () => Locale;
  now?: () => Date;
  routes?: readonly MockRoute[];
}

function scenarioFromLocation(): MockScenario | undefined {
  if (typeof window === 'undefined') return undefined;
  return toScenario(new URLSearchParams(window.location.search).get('mock'));
}

function localeFromDocument(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  return LOCALES.find((locale) => locale === document.documentElement.lang) ?? DEFAULT_LOCALE;
}

// Cookie-authenticated writes need the CSRF header; the real API answers 404 without it
// (docs/04 "CSRF"). A bearer request is exempt, and so is a request without credentials.
function lacksRequiredCsrf(request: TransportRequest): boolean {
  if (request.method === 'GET') return false;
  const cookieChannel =
    request.credentials === 'include' && request.headers.authorization === undefined;
  return cookieChannel && request.headers[CSRF_HEADER] === undefined;
}

function parseBody(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function toResponse(reply: MockReply): TransportResponse {
  const body = reply.error
    ? {
        success: false,
        error: {
          code: reply.error.code,
          message: `errors.${reply.error.code}`,
          ...(reply.error.details === undefined ? {} : { details: reply.error.details }),
        },
      }
    : {
        success: true,
        data: reply.data,
        ...(reply.meta === undefined ? {} : { meta: reply.meta }),
      };
  return { status: reply.status, retryAfter: null, body };
}

export function createMockTransport(options: MockTransportOptions): Transport {
  const routes = options.routes ?? ROUTES;
  const base = new URL(options.apiBaseUrl);
  return async (request: TransportRequest) => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (lacksRequiredCsrf(request)) return toResponse(fail('NOT_FOUND'));
    const url = new URL(request.url);
    const path = url.pathname.startsWith(base.pathname)
      ? url.pathname.slice(base.pathname.length)
      : url.pathname;
    const matched = matchRoute(routes, request.method, path);
    if (matched === undefined) return toResponse(fail('NOT_FOUND'));
    return toResponse(
      matched.route.handler({
        method: request.method,
        params: matched.params,
        query: url.searchParams,
        body: parseBody(request.body),
        headers: request.headers,
        scenario: (options.getScenario ?? scenarioFromLocation)(),
        locale: (options.getLocale ?? localeFromDocument)(),
        now: (options.now ?? (() => new Date()))(),
        siteUrl: options.siteUrl,
      }),
    );
  };
}

export const mockTransport: Transport = createMockTransport({
  apiBaseUrl: env.NEXT_PUBLIC_API_URL,
  siteUrl: env.NEXT_PUBLIC_SITE_URL,
  delayMs: 250,
});
