// Mini App channel: `POST /auth/telegram/webapp` with the Telegram initData, then a bearer token
// that lives only in this module's memory. Nothing is written to localStorage, sessionStorage
// or cookies (the Telegram web view may be an iframe, and a stored token outlives the chat).
import {
  CSRF_HEADER,
  webAppLoginBodySchema,
  webAppLoginResponseSchema,
  type WebAppLoginResponse,
} from '@repo/shared';
import type { AuthStrategy, RecoverOutcome, SessionLostHandler } from './auth-strategy';
import { parseResponse } from './envelope';
import { ApiError, isApiError } from './errors';
import { timeoutSignal, type Transport, type TransportRequest } from './transport';
import { apiUrl } from './url';

const LOGIN_TIMEOUT_MS = 15_000;

export interface TgAuthDeps {
  apiBaseUrl: string;
  transport: Transport;
  /** Raw `Telegram.WebApp.initData`, or null outside Telegram. Read at call time, never cached. */
  getInitData: () => string | null;
  onSessionLost: SessionLostHandler;
  /** A login returned a different user than the previous one: cached private data is theirs. */
  onUserChanged?: () => void;
  now?: () => number;
}

/**
 * What a login hands to the app. The bearer token is deliberately not part of it: only this
 * module sends it, so no component, query cache or log line can end up holding it.
 */
export type TgLoginResult = Omit<WebAppLoginResponse, 'token'>;

export interface TgAuth extends AuthStrategy {
  /** Exchanges the current initData for a session token. Concurrent calls share one request. */
  login(): Promise<TgLoginResult>;
  hasToken(): boolean;
}

const RETRY: RecoverOutcome = { kind: 'retry' };

export function createTgAuth(deps: TgAuthDeps): TgAuth {
  const now = deps.now ?? Date.now;
  let token: string | null = null;
  let epoch = 0;
  let loginInflight: Promise<TgLoginResult> | null = null;
  let lostNotified = false;
  // Set when a login is refused, until a login succeeds again. While it is set, a 401 does NOT
  // post the initData again: the server limits logins per Telegram account, and repeating a
  // refused one only turns INITDATA_EXPIRED into RATE_LIMITED. The explicit `login()` (gate
  // screen retry, app start) is the only way out.
  let lostError: ApiError | null = null;
  let lastUserId: string | null = null;

  // The Mini App has no web login page to go to: the gate screen handles a lost session.
  function handleLost(error?: ApiError): void {
    token = null;
    lostError = error ?? lostError ?? new ApiError({ status: 401, code: 'UNAUTHORIZED' });
    const firstLoss = !lostNotified;
    lostNotified = true;
    deps.onSessionLost(false, firstLoss);
  }

  async function loginOnce(): Promise<TgLoginResult> {
    const body = webAppLoginBodySchema.safeParse({ initData: deps.getInitData() ?? '' });
    // No (or oversized) initData: there is nothing the server could verify.
    if (!body.success) {
      const error = new ApiError({ status: 401, code: 'INITDATA_INVALID' });
      handleLost(error);
      throw error;
    }

    let response;
    try {
      response = await deps.transport({
        method: 'POST',
        url: apiUrl(deps.apiBaseUrl, '/auth/telegram/webapp'),
        // docs/04 asks for the CSRF header on every write, sign-in routes included.
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [CSRF_HEADER]: '1',
        },
        body: JSON.stringify(body.data),
        credentials: 'omit',
        cache: 'no-store',
        signal: timeoutSignal(LOGIN_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError({ status: 0, code: 'NETWORK' });
    }
    try {
      const { data } = parseResponse(response, webAppLoginResponseSchema, now());
      const { token: issued, ...result } = data;
      token = issued;
      epoch += 1;
      lostNotified = false;
      lostError = null;
      const userChanged = lastUserId !== null && lastUserId !== result.user.id;
      lastUserId = result.user.id;
      if (userChanged) deps.onUserChanged?.();
      return result;
    } catch (error) {
      // initData rejected or user blocked: whatever token we held no longer applies.
      if (isApiError(error) && (error.status === 401 || error.status === 403)) handleLost(error);
      throw error;
    }
  }

  function login(): Promise<TgLoginResult> {
    loginInflight ??= loginOnce().finally(() => {
      loginInflight = null;
    });
    return loginInflight;
  }

  return {
    channel: 'tg',

    prepare(request: TransportRequest, mode): TransportRequest {
      if (mode === 'anonymous' || mode === 'login' || token === null) return request;
      return { ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } };
    },

    epoch: () => epoch,

    async recover(failedEpoch: number): Promise<RecoverOutcome> {
      if (epoch > failedEpoch) return RETRY;
      if (lostError !== null) throw lostError;
      // INITDATA_EXPIRED / INITDATA_INVALID / USER_BLOCKED propagate: the gate screen decides.
      await login();
      return RETRY;
    },

    onSessionLost: (_redirect, reason) => handleLost(reason),

    // Signing out is final until an explicit login(): the same state as a refused login, so
    // no request posts the initData again behind the user's back.
    signOut() {
      token = null;
      lostError = new ApiError({ status: 401, code: 'UNAUTHORIZED' });
    },

    login,
    hasToken: () => token !== null,
  };
}
