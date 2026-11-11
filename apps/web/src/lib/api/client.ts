// The app-wide API client: environment, real transport, and the channel's auth strategy.
// Feature modules (`catalog.ts`, `me.ts`, ...) call `apiFetch` / `apiFetchList` from here.
import type { PageMeta } from '@repo/shared';
import type { z } from 'zod';
import { env } from '../../env';
import { getQueryClient } from '../query-client';
import type { AuthStrategy } from './auth-strategy';
import { createTgAuth, type TgAuth } from './auth-tg';
import type { LockManagerLike } from './auth-lock';
import { createWebAuth } from './auth-web';
import { ApiError } from './errors';
import { createApiClient, type ApiRequest } from './http';
import { isMocked, type MockGroupName } from './mock-groups';
import { createSessionLostHandler, scheduleClearPrivateQueries } from './session-lost';
import { fetchTransport, type Transport } from './transport';

// The dev mock is imported only where the bundler can prove NODE_ENV is not "production": in a
// production build this branch is removed, so the mock modules are not part of any chunk.
async function loadMockTransport(): Promise<Transport> {
  if (process.env.NODE_ENV !== 'production') {
    const { mockTransport } = await import('./mock/transport');
    return mockTransport;
  }
  throw new Error('The mock API transport does not exist in production builds.');
}

function transportFor(group: MockGroupName | undefined): Promise<Transport> {
  return isMocked(group) ? loadMockTransport() : Promise.resolve(fetchTransport);
}

const onSessionLost = createSessionLostHandler({
  getClient: getQueryClient,
  getLocation: () => (typeof window === 'undefined' ? undefined : window.location),
  navigate: (url) => window.location.assign(url),
});

/** The cross-tab lock the refresh, the sign-in and the sign-out share (see auth-lock.ts). */
export function getLocks(): LockManagerLike | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.locks;
}

const apiBaseUrl = env.NEXT_PUBLIC_API_URL;

export const webAuth: AuthStrategy = createWebAuth({
  apiBaseUrl,
  transport: fetchTransport,
  getLocks,
  onSessionLost,
});

// A strategy that refuses every request needing a session. Used where the real one must not run:
// on `/tg` before the Mini App provider has activated the Telegram channel (the cookie channel
// must never be used there by accident), and on the server, where the module-level state of the
// real strategies (the lost-session flag, the refresh epoch) would be shared between users.
function refusingStrategy(channel: 'web' | 'tg'): AuthStrategy {
  return {
    channel,
    prepare(request, mode) {
      if (mode === 'anonymous') return request;
      throw new ApiError({ status: 401, code: 'UNAUTHORIZED' });
    },
    epoch: () => 0,
    recover: () => Promise.resolve({ kind: 'retry' }),
    onSessionLost: () => undefined,
    signOut: () => undefined,
  };
}

const tgNotReady = refusingStrategy('tg');
const noSessionOnServer = refusingStrategy('web');

let tgAuth: TgAuth | null = null;

function onTelegramPath(): boolean {
  return typeof window !== 'undefined' && /^\/tg(\/|$)/.test(window.location.pathname);
}

/**
 * Switches the whole client to the Mini App channel. The `/tg` provider calls this with the live
 * initData source; later calls return the same instance, so a re-render cannot reset the token.
 */
export function activateTgAuth(getInitData: () => string | null): TgAuth {
  if (typeof window === 'undefined') {
    throw new Error('The Mini App channel exists only in the browser.');
  }
  if (tgAuth !== null) return tgAuth;
  tgAuth = createTgAuth({
    apiBaseUrl,
    transport: fetchTransport,
    getInitData,
    onSessionLost,
    // A different Telegram user on the same client: what is cached belongs to the previous one.
    onUserChanged: () => scheduleClearPrivateQueries(getQueryClient),
  });
  // Anything cached before the channel switch belongs to the web session.
  scheduleClearPrivateQueries(getQueryClient);
  return tgAuth;
}

export function getActiveAuth(): AuthStrategy {
  if (typeof window === 'undefined') return noSessionOnServer;
  if (tgAuth !== null) return tgAuth;
  return onTelegramPath() ? tgNotReady : webAuth;
}

const client = createApiClient({
  baseUrl: apiBaseUrl,
  getStrategy: getActiveAuth,
  transportFor,
});

export function apiFetch<S extends z.ZodType>(request: ApiRequest, schema: S): Promise<z.infer<S>> {
  return client.fetch(request, schema);
}

export function apiFetchList<S extends z.ZodType>(
  request: ApiRequest,
  itemSchema: S,
): Promise<{ items: z.infer<S>[]; meta: PageMeta }> {
  return client.fetchList(request, itemSchema);
}
