import { ERROR_HTTP_STATUS, type AdminPermission, type ErrorCode } from '@repo/shared';
import type { HttpMethod } from '../transport';

// The dev mock API: a route table instead of a server. Handlers return plain replies; the
// transport wraps them in the envelope the real API sends.

export interface MockRequest {
  method: HttpMethod;
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  body: unknown;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string>>;
  now: Date;
}

export interface MockReply {
  status: number;
  data?: unknown;
  meta?: unknown;
  error?: { code: ErrorCode; details?: unknown };
  /** A non-JSON body (the CSV export). */
  text?: string;
}

/** Write routes are async (the audit id is a SubtleCrypto digest, as on the API). */
export type MockHandler = (request: MockRequest) => MockReply | Promise<MockReply>;

export interface MockRoute {
  method: HttpMethod;
  /** `/admin/auth/status/:nonce`; path below the API base URL. */
  pattern: string;
  handler: MockHandler;
  /**
   * The permission of the route (the shared matrix): a signed-in role without it gets the API's
   * 404, and so does a request without a session. Auth routes leave it out.
   */
  permission?: AdminPermission;
}

export const ok = (data: unknown, status = 200): MockReply => ({ status, data });

export function fail(code: ErrorCode, details?: unknown): MockReply {
  return { status: ERROR_HTTP_STATUS[code], error: { code, details } };
}

export function matchRoute(
  routes: readonly MockRoute[],
  method: HttpMethod,
  path: string,
): { route: MockRoute; params: Record<string, string> } | undefined {
  const segments = path.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.pattern.split('/').filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matches = pattern.every((part, index) => {
      const segment = segments[index];
      if (segment === undefined) return false;
      if (!part.startsWith(':')) return part === segment;
      params[part.slice(1)] = decodeURIComponent(segment);
      return true;
    });
    if (matches) return { route, params };
  }
  return undefined;
}
