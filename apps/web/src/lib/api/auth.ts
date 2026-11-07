import {
  LOGIN_NONCE_PATTERN,
  loginStartResponseSchema,
  loginStatusResponseSchema,
  logoutResponseSchema,
  sessionUserResponseSchema,
  sessionsResponseSchema,
  type LoginStartResponse,
  type LoginStatusResponse,
  type LoginVerifyBody,
  type SessionItem,
  type SessionUserResponse,
} from '@repo/shared';
import { getQueryClient } from '../query-client';
import { broadcastAuthEvent } from './auth-broadcast';
import { withRefreshLock } from './auth-lock';
import { authTiming } from './auth-timing';
import { apiFetch, getActiveAuth, getLocks } from './client';
import { ApiError, isApiError } from './errors';
import { resourceId } from './path';
import { clearPrivateQueries } from './session-lost';
import { anySignal, timeoutSignal } from './transport';

// Web sign-in through the bot (docs/04 "Auth"). The Mini App signs in with initData instead
// (`TgAuth.login`). All of these are real endpoints: they are never mocked.

export function startLogin(signal?: AbortSignal): Promise<LoginStartResponse> {
  return apiFetch(
    { method: 'POST', path: '/auth/telegram/start', body: {}, session: 'login', signal },
    loginStartResponseSchema,
  );
}

export function getLoginStatus(nonce: string, signal?: AbortSignal): Promise<LoginStatusResponse> {
  // The API answers a malformed nonce with 404; there is no reason to ask.
  if (!LOGIN_NONCE_PATTERN.test(nonce)) {
    return Promise.reject(new ApiError({ status: 404, code: 'NOT_FOUND' }));
  }
  return apiFetch(
    { path: `/auth/telegram/status/${nonce}`, session: 'login', signal },
    loginStatusResponseSchema,
  );
}

/**
 * On success the API sets the session cookies; the client only gets the user. On the web channel
 * it runs inside the same cross-tab lock as the refresh: a sign-in must not start while another
 * tab is rotating the refresh token (the two would race for the cookies).
 */
export async function verifyLogin(
  body: LoginVerifyBody,
  signal?: AbortSignal,
): Promise<SessionUserResponse> {
  const run = async (): Promise<SessionUserResponse> => {
    // Its own timeout, joined with the caller's signal: this runs inside the cross-tab lock.
    const timeout = timeoutSignal(authTiming().verifyMs);
    let result: SessionUserResponse;
    try {
      result = await apiFetch(
        {
          method: 'POST',
          path: '/auth/telegram/verify',
          body,
          session: 'login',
          signal: signal === undefined ? timeout : anySignal([signal, timeout]),
        },
        sessionUserResponseSchema,
      );
    } catch (raw) {
      // The client lets an abort through untouched. Our own timeout is "no answer", like any other
      // network failure; the caller cancelling stays a cancellation.
      if (timeout.aborted && signal?.aborted !== true && !isApiError(raw)) {
        throw new ApiError({ status: 0, code: 'NETWORK' });
      }
      throw raw;
    }
    // Whatever is cached belongs to whoever was signed in before (or to nobody): it goes first,
    // then the session counts as valid again, so the screens refetch as the new user.
    clearPrivateQueries(getQueryClient());
    getActiveAuth().onSignedIn?.();
    broadcastAuthEvent('signed-in');
    return result;
  };
  return getActiveAuth().channel === 'web' ? withRefreshLock(getLocks(), run) : run();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ends the session on this device. The local side ends FIRST, before the request: the strategy is
 * signed out (final until the next sign-in, see AuthStrategy.signOut) and private data is dropped.
 * From then on session-bound requests are refused locally, so a 401 that arrives while the
 * logout is being retried can neither start a refresh nor redirect to the login page.
 *
 * What this cannot do is end a cookie session by itself: only the server clears the httpOnly
 * cookies. If the request gets no answer (NETWORK) the cookies stay in the browser and the
 * session is still alive on the server, so the promise REJECTS and the UI must not tell the user
 * they are signed out (phase 7 S3 acceptance criterion). A network failure, including a request
 * that exceeds its own timeout, is tried again twice with a backoff; an HTTP error answer is
 * final and is not retried. The attempts go out in `login` mode: `/auth/logout` is a public,
 * cookie-based route that needs the CSRF header, and a signed-out strategy refuses the
 * session-bound modes, so this is the only mode that reaches the server.
 *
 * The Mini App has no logout request: its session is a short-lived bearer token, `/auth/logout`
 * is a cookie-only public route (a bearer request without the CSRF header gets 404), and docs/04
 * defines nothing else for it. There the token is just thrown away.
 *
 * Deliberately takes no arguments: the waits live in auth-timing.ts, and `mutationFn: logout`
 * must not let TanStack Query's mutation variables change them.
 */
export async function logout(): Promise<void> {
  const auth = getActiveAuth();
  auth.signOut();
  clearPrivateQueries(getQueryClient());
  try {
    if (auth.channel === 'web') {
      await withRefreshLock(getLocks(), postLogout);
      // Only once the server has cleared the cookies: the other tabs share them.
      broadcastAuthEvent('signed-out');
    }
  } finally {
    // Anything that was refetched or cached while the request was out goes as well.
    clearPrivateQueries(getQueryClient());
  }
}

async function postLogout(): Promise<void> {
  const { logoutAttemptMs, logoutRetryDelaysMs } = authTiming();
  for (let attempt = 0; ; attempt += 1) {
    const signal = timeoutSignal(logoutAttemptMs);
    try {
      await apiFetch(
        { method: 'POST', path: '/auth/logout', body: {}, session: 'login', signal },
        logoutResponseSchema,
      );
      return;
    } catch (raw) {
      // The client lets an abort through untouched (a cancelled query is not a failure). Here the
      // only abort is our own timeout, which is "no answer" like any other network failure.
      const error =
        signal.aborted && !isApiError(raw) ? new ApiError({ status: 0, code: 'NETWORK' }) : raw;
      const delay = logoutRetryDelaysMs[attempt];
      if (!isApiError(error) || error.code !== 'NETWORK' || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

export function listSessions(signal?: AbortSignal): Promise<SessionItem[]> {
  return apiFetch({ path: '/auth/sessions', signal }, sessionsResponseSchema);
}

export async function revokeSession(id: string): Promise<void> {
  await apiFetch(
    { method: 'DELETE', path: `/auth/sessions/${resourceId(id)}` },
    logoutResponseSchema,
  );
}
