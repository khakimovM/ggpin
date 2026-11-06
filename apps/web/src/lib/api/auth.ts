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
import { apiFetch, getActiveAuth } from './client';
import { ApiError, isApiError } from './errors';
import { resourceId } from './path';
import { clearPrivateQueries } from './session-lost';

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

/** On success the API sets the session cookies; the client only gets the user. */
export async function verifyLogin(
  body: LoginVerifyBody,
  signal?: AbortSignal,
): Promise<SessionUserResponse> {
  const result = await apiFetch(
    { method: 'POST', path: '/auth/telegram/verify', body, session: 'login', signal },
    sessionUserResponseSchema,
  );
  // Whatever is cached belongs to whoever was signed in before (or to nobody): it goes first,
  // then the session counts as valid again, so the screens refetch as the new user.
  clearPrivateQueries(getQueryClient());
  getActiveAuth().onSignedIn?.();
  return result;
}

/** Waits before the 2nd and 3rd attempt of a logout that got no answer from the network. */
export const LOGOUT_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ends the session on this device. The local side always ends: private data is dropped and the
 * strategy is signed out, which is final until the next sign-in (see AuthStrategy.signOut).
 *
 * What this cannot do is end a cookie session by itself: only the server clears the httpOnly
 * cookies. If the request gets no answer (NETWORK) the cookies stay in the browser and the
 * session is still alive on the server, so the promise REJECTS and the UI must not tell the user
 * they are signed out (phase 7 S3 acceptance criterion). A network failure is tried again twice
 * with a backoff first; an HTTP error answer is final and is not retried.
 *
 * The Mini App has no logout request: its session is a short-lived bearer token, `/auth/logout`
 * is a cookie-only public route (a bearer request without the CSRF header gets 404), and docs/04
 * defines nothing else for it. There the token is just thrown away.
 */
export async function logout(
  retryDelaysMs: readonly number[] = LOGOUT_RETRY_DELAYS_MS,
): Promise<void> {
  const auth = getActiveAuth();
  try {
    if (auth.channel === 'web') await postLogout(retryDelaysMs);
  } finally {
    auth.signOut();
    clearPrivateQueries(getQueryClient());
  }
}

async function postLogout(retryDelaysMs: readonly number[]): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // `optional`: signing out with an already dead session must not bounce to the login page.
      await apiFetch(
        { method: 'POST', path: '/auth/logout', body: {}, session: 'optional' },
        logoutResponseSchema,
      );
      return;
    } catch (error) {
      const delay = retryDelaysMs[attempt];
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
