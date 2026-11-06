import { ERROR_HTTP_STATUS, type ErrorCode, type Locale } from '@repo/shared';
import type { HttpMethod } from '../transport';

// The dev mock API: a route table instead of a server. Handlers return plain replies; the
// transport wraps them in the same envelope the real API sends.

export const MOCK_SCENARIOS = [
  'insufficient',
  'recipientNotFound',
  'priceUnavailable',
  'orderFailed',
  'intentExpired',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export function toScenario(value: string | null): MockScenario | undefined {
  return MOCK_SCENARIOS.find((scenario) => scenario === value);
}

export interface MockRequest {
  method: HttpMethod;
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  body: unknown;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string>>;
  scenario: MockScenario | undefined;
  /** The page language, standing in for the profile language the real API uses. */
  locale: Locale;
  now: Date;
  siteUrl: string;
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
  /** `/payments/intents/:id`; path below the API base URL. */
  pattern: string;
  handler: MockHandler;
}

export const ok = (data: unknown, status = 200): MockReply => ({ status, data });

export function fail(code: ErrorCode, details?: unknown): MockReply {
  return { status: ERROR_HTTP_STATUS[code], error: { code, details } };
}

export function page<T>(items: readonly T[], query: URLSearchParams): MockReply {
  const pageNumber = Math.max(1, Number(query.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 20));
  const start = (pageNumber - 1) * limit;
  return {
    status: 200,
    data: items.slice(start, start + limit),
    meta: { page: pageNumber, limit, total: items.length },
  };
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
