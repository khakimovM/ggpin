import { applyDecorators } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { Public } from '../auth/public.decorator';

// Key under Fastify's per-route `config`; read back by the cache-policy onSend hook.
export const PUBLIC_CACHE_CONFIG_KEY = 'ggpinPublicCache';

export const PUBLIC_CACHE_MAX_AGE_MIN_SEC = 1;
// One hour: a shared cache may serve a stale catalog for at most this long after a price change.
export const PUBLIC_CACHE_MAX_AGE_MAX_SEC = 3_600;

/**
 * Marks a GET route as cacheable by browsers and shared caches for `maxAgeSec` seconds, and as
 * public (no session). Caching is opt-in: every response without this marker is `no-store`
 * (see cache-policy.ts), so a new route can never become cacheable by accident.
 *
 * Only for responses that are identical for every caller (catalog, never anything per user).
 * Throws when the decorator is applied (at class definition, i.e. at boot), not per request.
 *
 * Method-only on purpose: @nestjs/platform-fastify reads route `config` from the handler, so on
 * a class the RouteConfig half would silently do nothing while the Public() half still opened
 * every route of the controller. Typing it as MethodDecorator makes that a compile error.
 */
export function PublicCache(maxAgeSec: number): MethodDecorator {
  if (
    !Number.isInteger(maxAgeSec) ||
    maxAgeSec < PUBLIC_CACHE_MAX_AGE_MIN_SEC ||
    maxAgeSec > PUBLIC_CACHE_MAX_AGE_MAX_SEC
  ) {
    throw new RangeError(
      `PublicCache maxAgeSec must be an integer ${PUBLIC_CACHE_MAX_AGE_MIN_SEC}..${PUBLIC_CACHE_MAX_AGE_MAX_SEC}, got ${String(maxAgeSec)}`,
    );
  }
  return applyDecorators(Public(), RouteConfig({ [PUBLIC_CACHE_CONFIG_KEY]: { maxAgeSec } }));
}
