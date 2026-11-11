// Web store channel: httpOnly cookies set by the API, a CSRF header on writes, and one shared
// refresh when the short-lived access cookie expires. The client never sees a token.
import { CSRF_HEADER } from '@repo/shared';
import { REFRESH_LOCK_NAME, withRefreshLock, type LockManagerLike } from './auth-lock';
import type { AuthStrategy, RecoverOutcome, SessionLostHandler } from './auth-strategy';
import { authTiming } from './auth-timing';
import { errorFromResponse } from './envelope';
import { ApiError } from './errors';
import { timeoutSignal, type Transport, type TransportRequest } from './transport';
import { apiUrl } from './url';

// Re-exported for the callers that always found them here.
export { REFRESH_LOCK_NAME, type LockManagerLike };

export interface WebAuthDeps {
  apiBaseUrl: string;
  transport: Transport;
  /** Web Locks; absent in old browsers and tests, then only this tab is serialised. */
  getLocks?: () => LockManagerLike | undefined;
  onSessionLost: SessionLostHandler;
  now?: () => number;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRY: RecoverOutcome = { kind: 'retry' };
const signedOutError = (): ApiError => new ApiError({ status: 401, code: 'UNAUTHORIZED' });
const NETWORK = (): ApiError => new ApiError({ status: 0, code: 'NETWORK' });

export function createWebAuth(deps: WebAuthDeps): AuthStrategy {
  const now = deps.now ?? Date.now;
  let epoch = 0;
  let inflight: Promise<RecoverOutcome> | null = null;
  // Set once the session is known to be gone; cleared by the next sign-in.
  let lostError: ApiError | null = null;
  let lostNotified = false;
  // The user signed out on purpose. Unlike a lost session this is final until the next sign-in:
  // session-bound requests are refused in `prepare` without touching the network, nothing tries a
  // refresh, and nothing redirects (a redirect would carry the previous user's page in `next`).
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
        signal: timeoutSignal(authTiming().refreshMs),
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

  const runExclusive = (): Promise<RecoverOutcome> =>
    withRefreshLock(deps.getLocks?.(), refreshOnce);

  return {
    channel: 'web',

    prepare(request: TransportRequest, mode): TransportRequest {
      // After a deliberate sign-out nothing session-bound may leave the browser: it would carry
      // cookies that are (or, if the logout request got no answer, may still be) valid, and its
      // 401 could start a refresh. `login` (the logout retry itself, a new sign-in) and
      // `anonymous` (public reads) are not session-bound and go through.
      if (signedOut && (mode === 'required' || mode === 'optional')) throw signedOutError();
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
