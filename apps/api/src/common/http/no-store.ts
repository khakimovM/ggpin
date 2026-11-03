import type { NestFastifyApplication } from '@nestjs/platform-fastify';

// Responses that carry or depend on a session: login/refresh/logout/sessions and the profile.
// A shared cache or the browser's back/forward cache must never keep (or replay) them.
// Matched against the ROUTE PATTERN (`/api/v1/auth/telegram/status/:nonce`), not the raw URL:
// the router percent-decodes the path before matching (`/api/v1/%6De` reaches `/api/v1/me`),
// so a regex on the raw URL could be walked around.
const NO_STORE_ROUTE = /^\/api\/v1\/(auth|me)(\/|$)/;

/**
 * `route` is the matched route pattern, or undefined when no route matched (a 404). An
 * unmatched request is `no-store` too: its path may be an encoded spelling of a protected one,
 * and there is nothing worth caching in an error page.
 */
export function isNoStoreRoute(route: string | undefined): boolean {
  return route === undefined || NO_STORE_ROUTE.test(route);
}

/**
 * `Cache-Control: no-store` on every response under /api/v1/auth/* and /api/v1/me*, and on
 * every unmatched request. An `onSend` hook runs for every response, errors and 404s included,
 * after the handler and the exception filter, so nothing downstream can forget it.
 */
export function applyNoStore(app: NestFastifyApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, payload, done) => {
      const route = request.is404 ? undefined : request.routeOptions.url;
      if (isNoStoreRoute(route)) void reply.header('cache-control', 'no-store');
      done(null, payload);
    });
}
