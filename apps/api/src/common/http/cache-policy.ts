import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PUBLIC_CACHE_CONFIG_KEY } from './public-cache.decorator';

const NO_STORE = 'no-store';

// The minimal shape the decision needs; keeps the function testable without a Fastify instance.
export interface CachePolicyInput {
  /** False for an unmatched request (404 from the router). */
  readonly routeMatched: boolean;
  readonly method: string;
  readonly statusCode: number;
  /** `routeOptions.config` of the matched route. */
  readonly routeConfig: unknown;
  readonly hasSetCookie: boolean;
}

function publicCacheMaxAge(routeConfig: unknown): number | undefined {
  if (typeof routeConfig !== 'object' || routeConfig === null) return undefined;
  const marker: unknown = (routeConfig as Record<string, unknown>)[PUBLIC_CACHE_CONFIG_KEY];
  if (typeof marker !== 'object' || marker === null) return undefined;
  const maxAgeSec: unknown = (marker as Record<string, unknown>).maxAgeSec;
  return typeof maxAgeSec === 'number' && Number.isInteger(maxAgeSec) && maxAgeSec > 0
    ? maxAgeSec
    : undefined;
}

/**
 * The `Cache-Control` value for a response. Default-deny: `public, max-age=N` only for a
 * successful GET/HEAD on a route that opted in with @PublicCache(N) and that sets no cookie
 * (a cookie means the body may be per-user). Everything else, errors on cacheable routes
 * included, is `no-store`, so a shared cache can never keep a 404/400/500 or a session response.
 */
export function cacheControlFor(input: CachePolicyInput): string {
  if (
    !input.routeMatched ||
    (input.method !== 'GET' && input.method !== 'HEAD') ||
    input.statusCode !== 200 ||
    input.hasSetCookie
  ) {
    return NO_STORE;
  }
  const maxAgeSec = publicCacheMaxAge(input.routeConfig);
  return maxAgeSec === undefined ? NO_STORE : `public, max-age=${maxAgeSec}`;
}

/**
 * Sets `Cache-Control` on EVERY response. An `onSend` hook runs for every response, errors and
 * 404s included, after the handler and the exception filter, so nothing downstream can forget
 * it. `routeMatched` comes from the router's own verdict (`is404`), not from the raw URL: the
 * router percent-decodes the path before matching, so a URL regex could be walked around.
 */
export function applyCachePolicy(app: NestFastifyApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, payload, done) => {
      void reply.header(
        'cache-control',
        cacheControlFor({
          routeMatched: !request.is404,
          method: request.method,
          statusCode: reply.statusCode,
          routeConfig: request.routeOptions.config,
          hasSetCookie: reply.hasHeader('set-cookie'),
        }),
      );
      done(null, payload);
    });
}
