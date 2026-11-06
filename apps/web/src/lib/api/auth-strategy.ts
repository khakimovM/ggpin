// What differs between the two channels (docs/04 "Kanallar"): the web store authenticates with
// httpOnly cookies and a CSRF header, the Mini App with a bearer token kept in memory.
import type { ApiError } from './errors';
import type { TransportRequest } from './transport';

/**
 * - `required`: needs a session; when it is gone the user is sent to sign in.
 * - `optional`: uses the session when there is one (e.g. the header avatar on a public page);
 *   losing it is reported to the caller, not by a redirect.
 * - `login`: the sign-in routes themselves. They need the channel's transport settings (cookies
 *   must be accepted) but must never trigger a refresh.
 * - `anonymous`: public data; no cookie, no token.
 */
export type SessionMode = 'required' | 'optional' | 'login' | 'anonymous';

/**
 * Called when the session is gone. `firstLoss` is true only for the first loss since the last
 * sign-in, so cache cleanup and redirects are not repeated by every request that notices it.
 */
export type SessionLostHandler = (redirect: boolean, firstLoss: boolean) => void;

export type RecoverOutcome = { kind: 'retry' } | { kind: 'lost'; error: ApiError };

export interface AuthStrategy {
  readonly channel: 'web' | 'tg';
  /** Adds the channel's credentials (cookie flag, CSRF header or bearer token). */
  prepare(request: TransportRequest, mode: SessionMode): TransportRequest;
  /**
   * Counts successful refreshes/logins. A request remembers the value it was sent with; a 401
   * that arrives after somebody else already renewed the session is retried without renewing
   * again, which keeps "N parallel 401s" at exactly one refresh.
   */
  epoch(): number;
  /**
   * Called after a 401 `UNAUTHORIZED`. Resolves `retry` once the session is renewed, `lost`
   * when it cannot be (web: refresh refused, or the user is blocked). Throws an ApiError for failures that say nothing
   * about the session (network, 5xx, expired initData). `mode` matters once the session is
   * known to be lost: a `required` request still gets one more try (the user may have signed in
   * again in another tab), an `optional` one does not.
   */
  recover(failedEpoch: number, mode: SessionMode): Promise<RecoverOutcome>;
  /**
   * The session is gone: drop cached private data; `redirect` also moves to the sign-in page.
   * `reason` is the server's answer that ended it (e.g. USER_BLOCKED), kept for later requests.
   */
  onSessionLost(redirect: boolean, reason?: ApiError): void;
  /**
   * The user signed out on purpose. Final until the next sign-in: nothing tries to renew the
   * session and nothing redirects, whichever request still fails afterwards.
   */
  signOut(): void;
  /**
   * A new sign-in succeeded. Until then a session that was lost stays lost: optional requests do
   * not try to refresh it again (they would only repeat the failure and its cleanup).
   */
  onSignedIn?(): void;
}
