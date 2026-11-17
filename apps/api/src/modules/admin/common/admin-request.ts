import type { AdminUser } from '@repo/db';

/** A live admin session, as AdminGuard attached it to the request. */
export interface AdminPrincipal {
  readonly sessionId: string;
  /** Read from the database on THIS request: role and isActive are never older than it. */
  readonly admin: AdminUser;
  readonly expiresAt: Date;
  /** When the session dies if unused: min(expiresAt, lastUsedAt + ADMIN_SESSION_IDLE_SEC). */
  readonly idleExpiresAt: Date;
}

/**
 * The slice of the Fastify request the admin guards and @CurrentAdmin read (structural, no
 * `fastify` import). `cookies` is added by @fastify/cookie; `ip` honours TRUST_PROXY.
 */
export interface AdminRequest {
  readonly method: string;
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly cookies?: Readonly<Record<string, string | undefined>>;
  adminPrincipal?: AdminPrincipal;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** POST, PATCH and anything else that is not a read. */
export function isWriteMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** One header's value; a repeated header (an array) counts as malformed and gives null. */
export function singleHeader(request: AdminRequest, name: string): string | undefined | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return null;
  return value;
}
