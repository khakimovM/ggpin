// Which stored price rows may back a customer-facing price. Pure functions: the clock is passed
// in. The labels and the skew limit are owned by @repo/shared so the worker (writer) and the API
// (judge) can never disagree on them.
import { MAX_CLOCK_SKEW_MS } from '@repo/shared';

/** The latest `createdAt` a price row may have to be considered at `now`; later rows are ignored. */
export function latestAcceptedAt(now: Date): Date {
  return new Date(now.getTime() + MAX_CLOCK_SKEW_MS);
}

/**
 * True while `createdAt` is no older than `maxAgeMs` and no more than MAX_CLOCK_SKEW_MS in the
 * future. The age boundary is inclusive: a row exactly `maxAgeMs` old is still fresh, one
 * millisecond older is not.
 */
export function isFresh(createdAt: Date, now: Date, maxAgeMs: number): boolean {
  const age = now.getTime() - createdAt.getTime();
  return age <= maxAgeMs && age >= -MAX_CLOCK_SKEW_MS;
}
