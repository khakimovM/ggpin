import type { HttpAdapterHost } from '@nestjs/core';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import { ADMIN_ROUTE_SEGMENT } from '../../../common/auth/admin-route';
import { AppError } from '../../../common/exceptions/app-error';
import { servedPath } from '../../../common/http/api-path';
import type { AdminRequestGate } from './admin-request-gate';

const ADMIN_SEGMENTS = servedPath(ADMIN_ROUTE_SEGMENT).split('/'); // ['', 'api', 'v1', 'admin']

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // a malformed escape: compared as written
  }
}

/**
 * True for `/api/v1/admin` and everything under it, as the router sees paths: segments split on
 * a literal '/' only and percent-decoded one by one (`/api/v1/%61dmin/x` is admin, the router
 * serves admin routes there; `/api/v1%2Fadmin/x`, `/api/v1/adminx` and `/api/v1//admin` are not).
 */
export function isAdminPath(url: string): boolean {
  const segments = (url.split('?')[0] ?? '').split('/');
  return ADMIN_SEGMENTS.every((expected, i) => decodedSegment(segments[i] ?? '') === expected);
}

/**
 * The admin branch of the router's not-found path (S2R-1).
 *
 * Fastify sends some admin-prefixed requests to the not-found handler without running any Nest
 * route, guard included: an empty route parameter (`/admin/orders//refund` matches the route with
 * `id: ""`, which the adapter refuses with callNotFound), a method no admin route has, a target
 * the adapter cannot route. Without this hook those skipped the anonymous budget and kept
 * answering 404 after the budget was used up, while real routes answered 429.
 *
 * Here, in the not-found handler's preHandler (it runs for unmatched requests and for
 * callNotFound alike), such a request gets exactly what the guards give a route nobody may call:
 * AdminRequestGate.refuseUnrouted. 429: thrown to the error handler (AllExceptionsFilter, the
 * same shape as every 429). 404: the router's own not-found answer follows, the same shape as
 * every admin 404. Any other path, admin or not, is left alone.
 */
export function registerAdminNotFoundGate(
  host: HttpAdapterHost<FastifyAdapter>,
  gate: AdminRequestGate,
): void {
  // An application context without HTTP (the owner CLI) has no adapter.
  const adapter: FastifyAdapter | undefined = host.httpAdapter;
  if (adapter === undefined) return;
  adapter.getInstance().addHook('preHandler', async (request) => {
    if (!request.is404 || !isAdminPath(request.url)) return;
    try {
      await gate.refuseUnrouted(request);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return;
      throw error;
    }
  });
}
