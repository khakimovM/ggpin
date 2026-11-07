// Every wait the web auth flow depends on, in one place. The values are module-level state, not
// parameters of public functions: a stray argument (say `mutationFn: logout`, which TanStack Query
// calls with the mutation variables) must never be able to change how long a sign-out waits.

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

/** One logout request. The retry loop below holds the cross-tab lock, so it must stay short. */
export const LOGOUT_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * One sign-in request. It runs inside the cross-tab lock, so a hung server must not hold every
 * other tab's refresh and sign-out behind it; 20 s is far above a normal answer.
 */
export const VERIFY_TIMEOUT_MS = 20_000;

/** Waits before the 2nd and 3rd attempt of a logout that got no answer from the network. */
export const LOGOUT_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

export interface AuthTiming {
  refreshMs: number;
  lockWaitMs: number;
  logoutAttemptMs: number;
  verifyMs: number;
  logoutRetryDelaysMs: readonly number[];
}

const DEFAULTS: AuthTiming = {
  refreshMs: REFRESH_TIMEOUT_MS,
  lockWaitMs: LOCK_WAIT_MS,
  logoutAttemptMs: LOGOUT_ATTEMPT_TIMEOUT_MS,
  verifyMs: VERIFY_TIMEOUT_MS,
  logoutRetryDelaysMs: LOGOUT_RETRY_DELAYS_MS,
};

let current: AuthTiming = DEFAULTS;

/** Read at call time, so an override applies to the very next request. */
export const authTiming = (): Readonly<AuthTiming> => current;

/**
 * Tests only: they cannot wait a minute. Returns the function that restores the defaults.
 * Refuses to run in a production build, so no code path can shorten these waits there.
 */
export function __setAuthTimingForTests(overrides: Partial<AuthTiming>): () => void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Auth timing cannot be overridden in production builds.');
  }
  current = { ...DEFAULTS, ...overrides };
  return () => {
    current = DEFAULTS;
  };
}
