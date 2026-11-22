// Development-only transport that answers from fixtures. client.ts imports it dynamically behind
// `import.meta.env.DEV`, so it is not part of a production build (prod-build-check.mjs).
import { CSRF_HEADER, permissionsFor } from '@repo/shared';
import { env } from '../../../env';
import type { Transport, TransportRequest, TransportResponse } from '../transport';
import { authRoutes } from './auth-handlers';
import { confirmRoutes } from './confirm-handlers';
import { readMockState } from './mock-state';
import { readRoutes } from './read-handlers';
import { fail, matchRoute, type MockReply, type MockRoute } from './router';

const ROUTES: readonly MockRoute[] = [...authRoutes, ...confirmRoutes, ...readRoutes];

export interface MockTransportOptions {
  apiBaseUrl: string;
  /** Simulated latency, so loading states are visible while developing. */
  delayMs?: number;
  now?: () => Date;
  routes?: readonly MockRoute[];
}

// Like the real API (docs/04 "CSRF"): a write without the header is the admin surface's 404.
function lacksCsrf(request: TransportRequest): boolean {
  if (request.method === 'GET') return false;
  const token = request.headers[CSRF_HEADER];
  return token === undefined || token.trim() === '';
}

function parseBody(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function toResponse(reply: MockReply): TransportResponse {
  if (reply.text !== undefined) {
    return { status: reply.status, retryAfter: null, body: undefined, text: reply.text };
  }
  const body = reply.error
    ? {
        success: false,
        error: {
          code: reply.error.code,
          message: `errors.${reply.error.code}`,
          ...(reply.error.details === undefined ? {} : { details: reply.error.details }),
        },
      }
    : {
        success: true,
        data: reply.data,
        ...(reply.meta === undefined ? {} : { meta: reply.meta }),
      };
  return { status: reply.status, retryAfter: null, body };
}

// The `loading` scenario: no answer until TanStack Query drops the request.
function never(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

export function createMockTransport(options: MockTransportOptions): Transport {
  const routes = options.routes ?? ROUTES;
  const base = new URL(options.apiBaseUrl);
  return async (request) => {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (lacksCsrf(request)) return toResponse(fail('NOT_FOUND'));
    const url = new URL(request.url);
    const path = url.pathname.startsWith(base.pathname)
      ? url.pathname.slice(base.pathname.length)
      : url.pathname;
    const matched = matchRoute(routes, request.method, path);
    if (matched === undefined) return toResponse(fail('NOT_FOUND'));
    const permission = matched.route.permission;
    if (permission !== undefined) {
      // Like the AdminGuard: no session, or a role without the right, is the same 404 (D-26).
      const state = readMockState();
      if (!state.signedIn || !permissionsFor(state.role).includes(permission)) {
        return toResponse(fail('NOT_FOUND'));
      }
      if (state.scenario === 'error') return toResponse(fail('INTERNAL_ERROR'));
      if (state.scenario === 'loading') await never(request.signal);
    }
    return toResponse(
      matched.route.handler({
        method: request.method,
        params: matched.params,
        query: url.searchParams,
        body: parseBody(request.body),
        headers: request.headers,
        now: (options.now ?? (() => new Date()))(),
      }),
    );
  };
}

export const mockTransport: Transport = createMockTransport({
  apiBaseUrl: env.VITE_API_URL,
  delayMs: 200,
});
