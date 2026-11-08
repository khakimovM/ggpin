// The cross-window mutex of one user's purchase (Web Locks API): two windows of the same browser
// must not be in the "read the slot, write it, send" chain at once (order-attempts.ts).

/** One lock per user (the name is not the storage key: the record's key is versioned, the lock is not). */
export const attemptLockName = (userId: string): string => `ggpin:order-attempt:${userId}`;

/**
 * Runs `task` while this browser holds the user's purchase lock. A lock that is taken means a
 * purchase is on its way in another window: `onBusy` runs instead and nothing is sent. Without
 * Web Locks (old browsers, an insecure context, tests) the task just runs; beginAttempt's read-back
 * is the second line of defence.
 */
export async function withAttemptLock<T>(
  userId: string,
  task: () => Promise<T>,
  onBusy: () => T,
): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks === undefined) return task();
  let entered = false;
  try {
    return await locks.request(attemptLockName(userId), { ifAvailable: true }, (lock) => {
      entered = true;
      return lock === null ? onBusy() : task();
    });
  } catch (error) {
    // The lock could not even be asked for (a restricted context): carry on without it. Whatever
    // the task itself throws is passed on as it is.
    if (entered) throw error;
    return task();
  }
}
