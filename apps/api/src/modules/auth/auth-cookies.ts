import {
  ACCESS_TOKEN_TTL_SEC,
  authCookieNames,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SEC,
} from '@repo/shared';
import type { AppConfig } from '../../config/config.module';
import type { SessionTokens } from './web-session.service';

// Session cookies (Q11): host-only (no Domain, so they never reach sibling subdomains),
// HttpOnly, SameSite=Lax, Secure everywhere except NODE_ENV=development (Safari refuses Secure
// cookies on http://localhost), both on Path=/ of the API host. Names come from
// authCookieNames(NODE_ENV) only: in production the `__Host-` prefix makes the browser itself
// refuse the cookie if an attribute is ever dropped, and refuse one planted with a Domain (Q13).

export interface CookieSpec {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  /** Seconds. 0 deletes the cookie. */
  readonly maxAge: number;
  readonly secure: boolean;
}

/** The slice of the Fastify reply that @fastify/cookie adds; structural, no `fastify` import. */
export interface CookieReply {
  setCookie(
    name: string,
    value: string,
    options: {
      path: string;
      maxAge: number;
      httpOnly: true;
      secure: boolean;
      sameSite: 'lax';
      expires?: Date;
    },
  ): unknown;
}

export function isSecureCookie(nodeEnv: AppConfig['NODE_ENV']): boolean {
  return nodeEnv !== 'development';
}

/**
 * A prefixed name is a promise to the browser, which drops the cookie when it is broken: both
 * prefixes need Secure, `__Host-` also Path=/ (and no Domain, which CookieSpec cannot carry).
 * Secure is forced on; a wrong `__Host-` path is a programming error and fails loudly.
 */
export function enforcePrefixRules(spec: CookieSpec): CookieSpec {
  const host = spec.name.startsWith('__Host-');
  if (!host && !spec.name.startsWith('__Secure-')) return spec;
  if (host && spec.path !== '/') throw new Error(`cookie ${spec.name} must use Path=/`);
  return spec.secure ? spec : { ...spec, secure: true };
}

export function sessionCookieSpecs(
  tokens: SessionTokens,
  nodeEnv: AppConfig['NODE_ENV'],
): CookieSpec[] {
  const names = authCookieNames(nodeEnv);
  const secure = isSecureCookie(nodeEnv);
  const specs: CookieSpec[] = [
    {
      name: names.access,
      value: tokens.accessToken,
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_SEC,
      secure,
    },
    {
      name: names.refresh,
      value: tokens.refreshToken,
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_SEC,
      secure,
    },
  ];
  return specs.map(enforcePrefixRules);
}

// A cookie is only removed by the browser when name AND path match, so the clearing pair
// repeats the exact paths of the set pair.
export function clearCookieSpecs(nodeEnv: AppConfig['NODE_ENV']): CookieSpec[] {
  return sessionCookieSpecs({ accessToken: '', refreshToken: '' }, nodeEnv).map((spec) => ({
    ...spec,
    maxAge: 0,
  }));
}

function apply(reply: CookieReply, specs: readonly CookieSpec[]): void {
  for (const spec of specs) {
    reply.setCookie(spec.name, spec.value, {
      path: spec.path,
      maxAge: spec.maxAge,
      httpOnly: true,
      secure: spec.secure,
      sameSite: 'lax',
      // Max-Age wins in current browsers; Expires in the past covers the old ones.
      ...(spec.maxAge === 0 ? { expires: new Date(0) } : {}),
    });
  }
}

export function setSessionCookies(
  reply: CookieReply,
  tokens: SessionTokens,
  nodeEnv: AppConfig['NODE_ENV'],
): void {
  apply(reply, sessionCookieSpecs(tokens, nodeEnv));
}

/**
 * Safe to call before throwing: Set-Cookie headers put on the reply survive into the error
 * response, because the exception filter only calls `reply.status(...).send(...)`.
 */
export function clearSessionCookies(reply: CookieReply, nodeEnv: AppConfig['NODE_ENV']): void {
  apply(reply, clearCookieSpecs(nodeEnv));
}
