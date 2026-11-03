import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SEC,
} from '@repo/shared';
import type { AppConfig } from '../../config/config.module';
import type { SessionTokens } from './web-session.service';

// Session cookies (Q11): host-only (no Domain, so they never reach sibling subdomains),
// HttpOnly, SameSite=Lax, Secure everywhere except NODE_ENV=development (Safari refuses Secure
// cookies on http://localhost). The refresh cookie is confined to the auth routes.

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

export function sessionCookieSpecs(tokens: SessionTokens, secure: boolean): CookieSpec[] {
  return [
    {
      name: ACCESS_COOKIE_NAME,
      value: tokens.accessToken,
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_SEC,
      secure,
    },
    {
      name: REFRESH_COOKIE_NAME,
      value: tokens.refreshToken,
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_SEC,
      secure,
    },
  ];
}

// A cookie is only removed by the browser when name AND path match, so the clearing pair
// repeats the exact paths of the set pair.
export function clearCookieSpecs(secure: boolean): CookieSpec[] {
  return sessionCookieSpecs({ accessToken: '', refreshToken: '' }, secure).map((spec) => ({
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
  apply(reply, sessionCookieSpecs(tokens, isSecureCookie(nodeEnv)));
}

/**
 * Safe to call before throwing: Set-Cookie headers put on the reply survive into the error
 * response, because the exception filter only calls `reply.status(...).send(...)`.
 */
export function clearSessionCookies(reply: CookieReply, nodeEnv: AppConfig['NODE_ENV']): void {
  apply(reply, clearCookieSpecs(isSecureCookie(nodeEnv)));
}
