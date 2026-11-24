// The app-wide admin API client: environment, transport choice and the session-lost handler.
import type { PageMeta } from '@repo/shared';
import type { z } from 'zod';
import { env } from '../../env';
import type { MockGroupName } from '../../env-schema';
import { createAdminHttp, type AdminRequest } from './http';
import { isMockedWith } from './mock-groups';
import { fetchTransport, type Transport } from './transport';

// `import.meta.env.DEV` is replaced by a literal at build time: in a production build this branch
// is dead code, the dynamic import is dropped and no mock module reaches any chunk
// (scripts/prod-build-check.mjs proves it on the built files).
async function loadMockTransport(): Promise<Transport> {
  if (import.meta.env.DEV) {
    const { mockTransport } = await import('./mock/transport');
    return mockTransport;
  }
  throw new Error('The admin mock transport does not exist in production builds.');
}

function transportFor(group: MockGroupName | undefined): Promise<Transport> {
  const mocked = isMockedWith(group, {
    production: import.meta.env.PROD,
    groups: env.VITE_API_MOCKS,
  });
  return mocked ? loadMockTransport() : Promise.resolve(fetchTransport);
}

type SessionLostListener = () => void;
const sessionLostListeners = new Set<SessionLostListener>();

/** The app shell registers what "signed out" means (clear the cache, go to /login). */
export function onSessionLost(listener: SessionLostListener): () => void {
  sessionLostListeners.add(listener);
  return () => {
    sessionLostListeners.delete(listener);
  };
}

/**
 * This tab's session is over and the API said so in a 2xx (an admin revoked their own current
 * session, docs/04 `currentRevoked`; the cookie is already cleared): same path as a lost session.
 */
export function endCurrentSession(): void {
  sessionLostListeners.forEach((listener) => listener());
}

const http = createAdminHttp({
  baseUrl: env.VITE_API_URL,
  transportFor,
  onSessionLost: endCurrentSession,
});

export function apiFetch<S extends z.ZodType>(
  request: AdminRequest,
  schema: S,
): Promise<z.infer<S>> {
  return http.fetch(request, schema);
}

export function apiFetchList<S extends z.ZodType>(
  request: AdminRequest,
  itemSchema: S,
): Promise<{ items: z.infer<S>[]; meta: PageMeta }> {
  return http.fetchList(request, itemSchema);
}

/** A text body (CSV) of an admin GET; errors are parsed like every other call. */
export function apiFetchText(request: AdminRequest): Promise<string> {
  return http.fetchText(request);
}
