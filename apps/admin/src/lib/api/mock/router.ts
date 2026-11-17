import { ERROR_HTTP_STATUS, type ErrorCode } from '@repo/shared';
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
}

export type MockHandler = (request: MockRequest) => MockReply;

export interface MockRoute {
  method: HttpMethod;
  /** `/admin/auth/status/:nonce`; path below the API base URL. */
  pattern: string;
  handler: MockHandler;
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
