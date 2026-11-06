import { CSRF_HEADER, PAY_TOKEN_HEADER } from '@repo/shared';
import type { AppConfig } from '../../config/config.module';
import { PAY_VIEW_ROUTE, servedPath } from './api-path';

// Exactly the first-party frontends. WEB_URL and ADMIN_URL are already normalised to origins
// by env.ts; MINI_APP_URL is a full URL (e.g. https://ggpin.uz/tg), so only its origin counts,
// and the Set drops it when it equals WEB_URL's origin (the normal case).
export function corsOrigins(config: AppConfig): string[] {
  const origins = new Set<string>([config.WEB_URL, config.ADMIN_URL]);
  if (config.MINI_APP_URL !== undefined) origins.add(new URL(config.MINI_APP_URL).origin);
  return [...origins];
}

/** The public pay-page route (D-39); prefix + version as served. */
export const PAY_VIEW_PATH_PREFIX = `${servedPath(PAY_VIEW_ROUTE)}/`;

export interface CorsPolicy {
  readonly origin: string[];
  readonly credentials: boolean;
  readonly methods: string[];
  readonly allowedHeaders: string[];
  readonly exposedHeaders: string[];
  readonly maxAge: number;
}

/** Every route except the pay page: credentialed (cookie sessions), our frontends. */
export function defaultCorsPolicy(config: AppConfig): CorsPolicy {
  return {
    origin: corsOrigins(config),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // The CSRF header is required on state-changing cookie-session routes (rules/60-security.md,
    // D-26): a cross-site page cannot send it without a preflight, which this allowlist rejects.
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', CSRF_HEADER],
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
    maxAge: 600,
  };
}

/**
 * `GET /payments/pay/:intentId` (D-39): read by the web pay page only, with `credentials: 'omit'`
 * and the token in `X-Pay-Token`. So: WEB_URL alone (not the admin or a separate Mini App
 * origin), no credentials, GET only, and the token header allowed here and nowhere else.
 */
export function payViewCorsPolicy(config: AppConfig): CorsPolicy {
  return {
    origin: [config.WEB_URL],
    credentials: false,
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: [PAY_TOKEN_HEADER],
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
    maxAge: 600,
  };
}

/**
 * Which policy a request gets, by its path (the query is ignored). A preflight carries the
 * same path as the request it announces, so both see the same policy. Decided on the raw path
 * on purpose: a path that only reaches the pay route after decoding gets the default policy,
 * which does not allow `X-Pay-Token`, so the browser cannot send the token there.
 */
export function corsPolicyFor(config: AppConfig, url: string): CorsPolicy {
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  return path.startsWith(PAY_VIEW_PATH_PREFIX)
    ? payViewCorsPolicy(config)
    : defaultCorsPolicy(config);
}
