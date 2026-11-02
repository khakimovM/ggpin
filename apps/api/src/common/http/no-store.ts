import type { NestFastifyApplication } from '@nestjs/platform-fastify';

// Responses that carry or depend on a session: login/refresh/logout/sessions and the profile.
// A shared cache or the browser's back/forward cache must never keep (or replay) them.
const NO_STORE_PATH = /^\/api\/v1\/(auth|me)(\/|\?|$)/;

export function isNoStorePath(url: string): boolean {
  return NO_STORE_PATH.test(url);
}

/**
 * `Cache-Control: no-store` on every response under /api/v1/auth/* and /api/v1/me*. An `onSend`
 * hook runs for every response, errors and 404s included, after the handler and the exception
 * filter, so nothing downstream can forget it.
 */
export function applyNoStore(app: NestFastifyApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, payload, done) => {
      if (isNoStorePath(request.url)) void reply.header('cache-control', 'no-store');
      done(null, payload);
    });
}
