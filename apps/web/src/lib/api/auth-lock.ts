// The cross-tab mutex (Web Locks API) shared by everything that changes the cookie session:
// the refresh, the sign-in and the sign-out. One name, one wait limit, so they cannot overlap
// across tabs: a sign-in must not start while another tab is rotating the refresh token.
import { authTiming } from './auth-timing';
import { ApiError } from './errors';
import { timeoutSignal } from './transport';

/** Cross-tab mutex name (Web Locks API). */
export const REFRESH_LOCK_NAME = 'ggpin-refresh';

export interface LockManagerLike {
  request<T>(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Runs `task` while holding the lock. Without Web Locks (old browsers, tests) only this tab is
 * serialised and the task just runs. When the lock is not granted in time the answer is NETWORK
 * ("no answer"), never a verdict on the session; whatever `task` itself throws is passed on as is.
 */
export async function withRefreshLock<T>(
  locks: LockManagerLike | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (locks === undefined) return task();
  let entered = false;
  try {
    // The signal bounds the wait for another tab that holds the lock.
    return await locks.request(
      REFRESH_LOCK_NAME,
      { signal: timeoutSignal(authTiming().lockWaitMs) },
      () => {
        entered = true;
        return task();
      },
    );
  } catch (error) {
    if (entered) throw error;
    throw new ApiError({ status: 0, code: 'NETWORK' });
  }
}
