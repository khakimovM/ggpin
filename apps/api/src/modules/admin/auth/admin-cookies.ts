import { ADMIN_SESSION_TTL_SEC, adminSessionCookieName } from '@repo/shared';
import type { AppConfig } from '../../../config/config.module';
import { enforcePrefixRules, isSecureCookie, type CookieSpec } from '../../auth/auth-cookies';

// The admin session cookie (docs/04 «Sessiya»): one cookie, host-only (no Domain), Path=/,
// HttpOnly, SameSite=Strict (the panel is never entered from another site with a session),
// Secure everywhere except NODE_ENV=development. The name comes from adminSessionCookieName only:
// `__Host-adm_session` in production, so the browser itself refuses it without Secure or with
// a Domain, and a sibling subdomain cannot plant one.

/** The slice of the Fastify reply that @fastify/cookie adds; structural, no `fastify` import. */
export interface AdminCookieReply {
  setCookie(
    name: string,
    value: string,
    options: {
      path: string;
      maxAge: number;
      httpOnly: true;
      secure: boolean;
      sameSite: 'strict';
      expires?: Date;
    },
  ): unknown;
}

export function adminCookieSpec(token: string, nodeEnv: AppConfig['NODE_ENV']): CookieSpec {
  return enforcePrefixRules({
    name: adminSessionCookieName(nodeEnv),
    value: token,
    path: '/',
    // The browser drops it when the session's absolute life ends; idle death is the server's.
    maxAge: ADMIN_SESSION_TTL_SEC,
    secure: isSecureCookie(nodeEnv),
  });
}

function apply(reply: AdminCookieReply, spec: CookieSpec): void {
  reply.setCookie(spec.name, spec.value, {
    path: spec.path,
    maxAge: spec.maxAge,
    httpOnly: true,
    secure: spec.secure,
    sameSite: 'strict',
    // Max-Age wins in current browsers; Expires in the past covers the old ones.
    ...(spec.maxAge === 0 ? { expires: new Date(0) } : {}),
  });
}

export function setAdminCookie(
  reply: AdminCookieReply,
  token: string,
  nodeEnv: AppConfig['NODE_ENV'],
): void {
  apply(reply, adminCookieSpec(token, nodeEnv));
}

/** Same name and path as the set cookie (a browser removes a cookie only when both match). */
export function clearAdminCookie(reply: AdminCookieReply, nodeEnv: AppConfig['NODE_ENV']): void {
  apply(reply, { ...adminCookieSpec('', nodeEnv), maxAge: 0 });
}
