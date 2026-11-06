// Web store channel: httpOnly cookies set by the API, a CSRF header on writes, and one shared
// refresh when the short-lived access cookie expires. The client never sees a token.
import { CSRF_HEADER } from '@repo/shared';
import type { AuthStrategy, RecoverOutcome, SessionLostHandler } from './auth-strategy';
import { errorFromResponse } from './envelope';
import { ApiError, isApiError } from './errors';
import { timeoutSignal, type Transport, type TransportRequest } from './transport';
import { apiUrl } from './url';

/** Cross-tab mutex name (Web Locks API). */
export const REFRESH_LOCK_NAME = 'ggpin-refresh';

/**
 * How long a refresh may take before the browser gives up on it. Deliberately long: the server
 * rotates the refresh token as it handles the request, so it can commit the rotation while the
 * response is still on its way. If we aborted early we would keep the OLD cookie, the next
 * refresh would send it again, and the server would take that for a stolen, replayed token and
 * revoke the whole session family. A slow answer is much cheaper than a forced sign-out.
 * The cross-tab lock is held until the request has finished (or this timeout fires).
 */
export const REFRESH_TIMEOUT_MS = 60_000;

/** Waiting for another tab's refresh can take up to its own timeout, plus a margin. */
export const LOCK_WAIT_MS = REFRESH_TIMEOUT_MS + 15_000;

export interface LockManagerLike {
  request<T>(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface WebAuthDeps {
  apiBaseUrl: string;
  transport: Transport;
  /** Web Locks; absent in old browsers and tests, then only this tab is serialised. */
  getLocks?: () => LockManagerLike | undefined;
  onSessionLost: SessionLostHandler;
  now?: () => number;
  /** Overrides the timeouts above; for tests, which cannot wait a minute. */
  timeouts?: { refreshMs?: number; lockWaitMs?: number };
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRY: RecoverOutcome = { kind: 'retry' };
const signedOutError = (): ApiError => new ApiError({ status: 401, code: 'UNAUTHORIZED' });
const NETWORK = (): ApiError => new ApiError({ status: 0, code: 'NETWORK' });

export function createWebAuth(deps: WebAuthDeps): AuthStrategy {
  const now = deps.now ?? Date.now;
  const refreshMs = deps.timeouts?.refreshMs ?? REFRESH_TIMEOUT_MS;
  const lockWaitMs = deps.timeouts?.lockWaitMs ?? LOCK_WAIT_MS;
  let epoch = 0;
  let inflight: Promise<RecoverOutcome> | null = null;
  // Set once the session is known to be gone; cleared by the next sign-in.
  let lostError: ApiError | null = null;
  let lostNotified = false;
  // The user signed out on purpose. Unlike a lost session this is final until the next sign-in:
  // no mode tries a refresh, and nothing redirects (a redirect would carry the previous user's
  // page in `next`).
  let signedOut = false;

  async function refreshOnce(): Promise<RecoverOutcome> {
    let response;
    try {
      response = await deps.transport({
        method: 'POST',
        url: apiUrl(deps.apiBaseUrl, '/auth/refresh'),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [CSRF_HEADER]: '1',
        },
        body: '{}',
        credentials: 'include',
        cache: 'no-store',
        signal: timeoutSignal(refreshMs),
      });
    } catch {
      // Offline or slow during a refresh says nothing about the session: keep it.
      throw NETWORK();
    }
    // Any 2xx means the cookies were rotated; the body is not needed to carry on.
    if (response.status >= 200 && response.status < 300) {
      epoch += 1;
      return RETRY;
    }
    const error = errorFromResponse(response, now());
    // 401 covers an expired/unknown refresh cookie and TOKEN_REUSE_DETECTED (the whole session
    // family was revoked); a blocked user cannot use the session either.
    if (error.status === 401 || error.code === 'USER_BLOCKED') return { kind: 'lost', error };
    throw error;
  }

  async function runExclusive(): Promise<RecoverOutcome> {
    const locks = deps.getLocks?.();
    if (locks === undefined) return refreshOnce();
    try {
      // The signal bounds the wait for another tab that holds the lock.
      return await locks.request(
        REFRESH_LOCK_NAME,
        { signal: timeoutSignal(lockWaitMs) },
        refreshOnce,
      );
    } catch (error) {
      throw isApiError(error) ? error : NETWORK();
    }
  }

  return {
    channel: 'web',

    prepare(request: TransportRequest, mode): TransportRequest {
      const headers = SAFE_METHODS.has(request.method)
        ? request.headers
        : { ...request.headers, [CSRF_HEADER]: '1' };
      return { ...request, headers, credentials: mode === 'anonymous' ? 'omit' : 'include' };
    },

    epoch: () => epoch,

    recover(failedEpoch: number, mode): Promise<RecoverOutcome> {
      if (signedOut) return Promise.resolve({ kind: 'lost', error: signedOutError() });
      if (lostError !== null) {
        // Optional requests accept the loss. A required one tries once more: another tab may
        // have signed in again, and the cookies are shared.
        if (mode !== 'required') return Promise.resolve({ kind: 'lost', error: lostError });
      } else if (epoch > failedEpoch) {
        // Another request already renewed the session after this one was sent.
        return Promise.resolve(RETRY);
      }
      if (inflight === null) {
        inflight = runExclusive()
          .then((outcome) => {
            if (outcome.kind === 'lost') {
              lostError = outcome.error;
            } else {
              lostError = null;
              lostNotified = false;
            }
            return outcome;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },

    onSessionLost(redirect: boolean, reason?: ApiError) {
      // After an explicit sign-out the failing requests of the old screens are expected.
      if (signedOut) return;
      lostError = reason ?? lostError ?? new ApiError({ status: 401, code: 'UNAUTHORIZED' });
      const firstLoss = !lostNotified;
      lostNotified = true;
      deps.onSessionLost(redirect, firstLoss);
    },

    signOut() {
      signedOut = true;
    },

    onSignedIn() {
      signedOut = false;
      lostError = null;
      lostNotified = false;
    },
  };
}
