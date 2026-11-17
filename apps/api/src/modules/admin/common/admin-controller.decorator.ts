import { applyDecorators, Controller } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ADMIN_ROUTE_SEGMENT } from '../../../common/auth/admin-route';

/**
 * Every admin controller: served under `/api/v1/admin/<path>`, and out of the global per-IP
 * throttler, whose X-RateLimit-* headers would make a refused admin route look different from
 * an unknown `/admin/*` path (D-26: one 404, same body and headers). The admin limits are
 * AdminThrottle's (per session, per anonymous IP); the login routes opt back in with
 * `@SkipThrottle({ default: false })` and their own @Throttle budgets. An empty `path` serves a
 * controller whose routes have several roots straight under `/api/v1/admin/` (catalog, settings).
 */
export const AdminController = (path: string): ClassDecorator =>
  applyDecorators(
    Controller(path === '' ? ADMIN_ROUTE_SEGMENT : `${ADMIN_ROUTE_SEGMENT}/${path}`),
    SkipThrottle(),
  );
