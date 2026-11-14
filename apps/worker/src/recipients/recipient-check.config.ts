import { RECIPIENT_CHECK_RETENTION_SEC, RECIPIENT_CHECK_TIMEOUT_MS } from '@repo/shared';

// Fixed settings of the `validate-recipient` consumer (phase 5 S3b, docs/06). Constants, not env:
// they follow from the API's contract (it waits RECIPIENT_CHECK_TIMEOUT_MS from its `queue.add`,
// keeps a finished job RECIPIENT_CHECK_RETENTION_SEC) and from how gently Fragment is asked.

/**
 * BullMQ limiter, shared by every worker replica (it lives in Redis): at most one lookup per
 * second reaches the provider (plan S3b). Fragment has no public API and an account that looks
 * like a bot can lose its session; one per second is far above our load (the API allows 20
 * checks a minute per user and one job answers every identical question for 60 s), and a burst
 * only queues: a job whose answer comes too late is dropped (see the deadline below) and the
 * API answers 503, never "not found".
 */
export const VALIDATE_RECIPIENT_LIMITER = { max: 1, duration: 1_000 } as const;

/**
 * Job SLOTS in flight at once. The limiter starts at most one job per second and every job ends
 * by its deadline (under RECIPIENT_CHECK_TIMEOUT_MS after its add), so about ten slots are taken
 * even if the provider hangs on each: with ten, one slow lookup never holds up a fast one, and
 * the limiter, not the slot count, bounds how often the provider is asked. The deadline frees the
 * slot only: the provider call itself is NOT aborted and may run on (Deadline); a real adapter
 * needs its own hard timeout and an AbortSignal (S7/S8 gate).
 */
export const VALIDATE_RECIPIENT_CONCURRENCY = Math.ceil(
  RECIPIENT_CHECK_TIMEOUT_MS / VALIDATE_RECIPIENT_LIMITER.duration,
);

export interface RecipientCheckTiming {
  /** How long the API waits from its `queue.add` (job.timestamp): RECIPIENT_CHECK_TIMEOUT_MS. */
  readonly waitMs: number;
  /**
   * The answer must be ready this long before the API stops waiting: storing the result, the
   * `completed` event and the API's XREAD take that time. An answer after it is wasted work.
   */
  readonly replyMarginMs: number;
  /** With less time left than this the provider is not asked at all (a stale job). */
  readonly minCallMs: number;
  /** Period of the retention sweep (RecipientJobSweeper). */
  readonly sweepEveryMs: number;
  /** A finished (or never taken) job older than this is removed: the API's retention. */
  readonly retentionMs: number;
}

export const RECIPIENT_CHECK_TIMING = Symbol('RECIPIENT_CHECK_TIMING');

export const DEFAULT_RECIPIENT_CHECK_TIMING: RecipientCheckTiming = Object.freeze({
  waitMs: RECIPIENT_CHECK_TIMEOUT_MS,
  replyMarginMs: 1_000,
  minCallMs: 500,
  // Half the retention: a job is gone at most 60 + 30 s after it finished (two windows = 120 s).
  sweepEveryMs: (RECIPIENT_CHECK_RETENTION_SEC * 1_000) / 2,
  retentionMs: RECIPIENT_CHECK_RETENTION_SEC * 1_000,
});
