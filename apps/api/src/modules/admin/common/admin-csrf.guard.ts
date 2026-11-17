import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_HEADER } from '@repo/shared';
import { isAdminRoute } from '../../../common/auth/admin-route';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { ADMIN_PUBLIC_KEY } from './admin-public.decorator';
import { isWriteMethod, singleHeader, type AdminRequest } from './admin-request';
import { AdminThrottle } from './admin-throttle';

/**
 * Whether a request may come from the admin SPA at all (docs/04 «CORS va Origin», SA-H2, N5).
 * Every admin request, reads included, is refused when
 *   - `Sec-Fetch-Site: cross-site`: another site's page made the browser send it;
 *   - `Sec-Fetch-Mode: no-cors | navigate`: an <img>/<script> tag or a link, which a browser
 *     sends without an Origin header (the SPA always uses fetch, mode `cors`);
 *   - an `Origin` is present and is not exactly ADMIN_URL (WEB_URL included);
 *   - a `Sec-Fetch-Site` header is present but `Origin` is not ADMIN_URL (S2-5): a browser
 *     sends both on the SPA's cross-origin fetch, so a browser request without the right Origin
 *     is not the SPA. Without any Sec-Fetch-* header (curl, the CLI) only the Origin rule applies.
 * Every write (POST/PATCH), the login routes included, also needs a non-empty X-CSRF-Token AND
 * `Origin === ADMIN_URL`: a cross-site page cannot add the header without a preflight, which the
 * admin CORS policy refuses for every other origin. A repeated header is malformed: refused.
 */
export function adminRequestAllowed(request: AdminRequest, adminOrigin: string): boolean {
  const site = singleHeader(request, 'sec-fetch-site');
  const mode = singleHeader(request, 'sec-fetch-mode');
  const origin = singleHeader(request, 'origin');
  if (site === null || mode === null || origin === null) return false;
  if (site?.toLowerCase() === 'cross-site') return false;
  const fetchMode = mode?.toLowerCase();
  if (fetchMode === 'no-cors' || fetchMode === 'navigate') return false;
  if (origin !== undefined && origin !== adminOrigin) return false;
  if (site !== undefined && origin !== adminOrigin) return false;
  if (!isWriteMethod(request.method)) return true;
  const token = singleHeader(request, CSRF_HEADER);
  return typeof token === 'string' && token.trim() !== '' && origin === adminOrigin;
}

// Global guard (AdminModule), the first of the two admin guards: the request's shape is checked
// before any session lookup. Non-admin routes pass untouched (they have CsrfGuard). A refusal is
// the admin surface's one 404 (D-26); on a session route it also counts against the anonymous
// per-IP budget (a login route has its own @Throttle budget instead).
@Injectable()
export class AdminCsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly throttle: AdminThrottle,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ADMIN_URL'>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!isAdminRoute(context)) return true;
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (adminRequestAllowed(request, this.config.ADMIN_URL)) return true;
    const handler = context.getHandler();
    if (this.reflector.get<boolean | undefined>(ADMIN_PUBLIC_KEY, handler) === true) {
      throw new AppError('NOT_FOUND');
    }
    return this.throttle.refuseAnonymous(request.ip);
  }
}
