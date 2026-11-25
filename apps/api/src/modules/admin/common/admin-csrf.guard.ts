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
 *   - a `Sec-Fetch-Site` header is present but `Origin` is absent (S2-5), unless it is the
 *     same-origin read below. S2-5 was written when the SPA called the API cross-origin
 *     (admin.ggpin.uz -> api.ggpin.uz): a browser then sends Origin on every fetch, reads included,
 *     so a browser request without it was not the SPA. Since P11-S3 (D-73 (10)) the proxy serves
 *     the admin API on the SPA's own origin (https://admin.ggpin.uz/api/v1/admin/*), and a browser
 *     sends NO Origin on a same-origin GET/HEAD fetch, only `Sec-Fetch-Site: same-origin`.
 *     Without any Sec-Fetch-* header (curl, the CLI) only the Origin rule applies.
 * The same-origin read is allowed only when ALL hold: GET or HEAD, `Sec-Fetch-Site` exactly
 * `same-origin` (`same-site` stays refused: ggpin.uz and api.ggpin.uz are the admin's site, so an
 * XSS on the store arrives as same-site; `none`, a typed URL, too), no Origin, `Sec-Fetch-Mode`
 * exactly `cors` or `same-origin`, `Sec-Fetch-Dest: empty` (a fetch, not a frame or document), and
 * the raw Host header, lower-cased and with only an explicit `:443` dropped on an https ADMIN_URL,
 * exactly ADMIN_URL's host. Admin GET handlers send no OTP and change no state; the one GET that
 * writes is the audit CSV export (its own audit row and export counter, GET only).
 * The Host check is defence in depth: a same-origin fetch from a page on another of our names
 * (api.ggpin.uz) carries that name. It reads the raw `Host` header, never request.hostname: with
 * TRUST_PROXY set, Fastify takes request.host from X-Forwarded-Host, which would make the check
 * depend on the proxy's header rewriting. The P11-S3 proxy (`deploy/proxy/Caddyfile` on
 * `feat/p11-launch`) forwards Host unchanged (no `header_up Host`), and a page cannot set Host on a
 * fetch; a proxy that rewrote it would only refuse the SPA's reads (fail closed).
 * Repeated headers over real HTTP: Node keeps the first `Host` and drops the rest (Caddy itself
 * answers 400 to two Hosts), and joins a repeated `Origin` or `Sec-Fetch-*` into one "a, b"
 * value, which no exact comparison here accepts. An array value (inject, unit tests) is refused by
 * singleHeader as a further layer only.
 * Every write (POST/PATCH), the login routes included, also needs a non-empty X-CSRF-Token AND
 * `Origin === ADMIN_URL`: a browser sends Origin on every same-origin write too, and a cross-site
 * page cannot add the header without a preflight, which the admin CORS policy refuses for every
 * other origin.
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
  if (site !== undefined && origin === undefined && !sameOriginRead(request, adminOrigin)) {
    return false;
  }
  if (!isWriteMethod(request.method)) return true;
  const token = singleHeader(request, CSRF_HEADER);
  return typeof token === 'string' && token.trim() !== '' && origin === adminOrigin;
}

/** The admin SPA's own GET/HEAD fetch on ADMIN_URL's origin (the browser sends no Origin). */
function sameOriginRead(request: AdminRequest, adminOrigin: string): boolean {
  // GET and HEAD only: OPTIONS (a preflight, never sent same-origin) and writes gain nothing here.
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (singleHeader(request, 'sec-fetch-site') !== 'same-origin') return false;
  const mode = singleHeader(request, 'sec-fetch-mode');
  if (mode !== 'cors' && mode !== 'same-origin') return false;
  // fetch()/XHR: the destination is empty (an <iframe>, <img> or document load is not).
  if (singleHeader(request, 'sec-fetch-dest') !== 'empty') return false;
  // The raw Host header; X-Forwarded-Host is never read.
  const host = singleHeader(request, 'host');
  if (typeof host !== 'string') return false;
  const admin = adminUrl(adminOrigin);
  if (admin === null) return false;
  // Lower case; only an explicit default HTTPS port is dropped (URL.host already omits it).
  let actual = host.toLowerCase();
  if (admin.protocol === 'https:' && actual.endsWith(':443')) actual = actual.slice(0, -4);
  return actual === admin.host;
}

/** ADMIN_URL parsed; env.ts has already validated it as an origin, so null is fail-closed only. */
function adminUrl(adminOrigin: string): URL | null {
  try {
    return new URL(adminOrigin);
  } catch {
    return null;
  }
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
