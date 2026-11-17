import { CSRF_HEADER, PAY_TOKEN_HEADER } from '@repo/shared';
import type { AppConfig } from '../../config/config.module';
import { ADMIN_ROUTE_SEGMENT } from '../auth/admin-route';
import { PAY_VIEW_ROUTE, servedPath } from './api-path';

// The user-facing frontends only (SA-H2): WEB_URL is already normalised to an origin by env.ts;
// MINI_APP_URL is a full URL (e.g. https://ggpin.uz/tg), so only its origin counts, and the Set
// drops it when it equals WEB_URL's origin (the normal case). ADMIN_URL is NOT here: the admin
// SPA talks to the admin routes only, which have their own policy (adminCorsPolicy). The user
// CsrfGuard reads the same list, so ADMIN_URL is no valid Origin for a user write either.
export function corsOrigins(config: AppConfig): string[] {
  const origins = new Set<string>([config.WEB_URL]);
  if (config.MINI_APP_URL !== undefined) origins.add(new URL(config.MINI_APP_URL).origin);
  return [...origins];
}

/** The public pay-page route (D-39); prefix + version as served. */
export const PAY_VIEW_PATH_PREFIX = `${servedPath(PAY_VIEW_ROUTE)}/`;

/** Every admin route (docs/04 «Admin»); prefix + version as served, no trailing slash. */
export const ADMIN_PATH = servedPath(ADMIN_ROUTE_SEGMENT);

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
  if (isAdminPath(path)) return adminCorsPolicy(config);
  return path.startsWith(PAY_VIEW_PATH_PREFIX)
    ? payViewCorsPolicy(config)
    : defaultCorsPolicy(config);
}

/**
 * `/api/v1/admin/*` (SA-H2): credentialed, ADMIN_URL alone, no `Authorization` (the admin
 * session is the cookie only) and no DELETE (the admin contract has none).
 */
export function adminCorsPolicy(config: AppConfig): CorsPolicy {
  return {
    origin: [config.ADMIN_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', CSRF_HEADER],
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
    maxAge: 600,
  };
}

// The router decodes percent-escapes before it matches, so `/api/v1/%61dmin/...` reaches an
// admin handler: the admin policy is chosen when the raw OR the decoded path is under the admin
// prefix (unlike the pay view, where only the raw path may widen the policy). A path with a
// malformed escape is decided by the raw test alone.
function isAdminPath(path: string): boolean {
  const under = (p: string): boolean => p === ADMIN_PATH || p.startsWith(`${ADMIN_PATH}/`);
  if (under(path)) return true;
  try {
    return under(decodeURIComponent(path));
  } catch {
    return false;
  }
}
