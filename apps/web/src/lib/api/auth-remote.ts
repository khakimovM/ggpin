// What a tab does when ANOTHER tab of the same browser signs in or out (see auth-broadcast.ts).
// The cookies are shared, so the session really did change; only this tab's memory is stale.
import { useAuthUiStore } from '../../stores/auth-ui-store';
import { getQueryClient } from '../query-client';
import type { AuthEvent } from './auth-broadcast';
import { getActiveAuth } from './client';
import { clearPrivateQueries } from './session-lost';

/**
 * - `signed-out`: the same final state as a local sign-out. Requests that need a session are
 *   refused without touching the network and nothing redirects; the screens show their
 *   "sign in" call to action instead of bouncing the visitor away from what they were reading.
 * - `signed-in`: the state a sign-in here would leave. A tab that was signed out (or lost its
 *   session) works again, and whatever it cached belonged to the previous user.
 */
export function applyRemoteAuthEvent(type: AuthEvent): void {
  const auth = getActiveAuth();
  // The Mini App has no cookie session; its token lives in this tab's memory only.
  if (auth.channel !== 'web') return;
  if (type === 'signed-out') {
    auth.signOut();
  } else {
    auth.onSignedIn?.();
    // A sign-out that failed here is moot now: without this the "sign-out failed" screen of
    // AuthGuard would stay up although the browser has a fresh session.
    useAuthUiStore.getState().setLogout('idle');
  }
  clearPrivateQueries(getQueryClient());
}
