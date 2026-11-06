/** DI token of the card-lock waits; tests with heavy concurrency give themselves more room. */
export const CARD_LOCK_TIMING = Symbol('CARD_LOCK_TIMING');

export interface CardLockTiming {
  /** `lock_timeout` of an allocation: a request waits this long for a busy card (then 55P03). */
  readonly lockWaitMs: number;
  /**
   * Prisma's wait to START the transaction. Below pg's pool timeout (CONNECTION_TIMEOUT_MS,
   * 5 s, @repo/db), so an exhausted pool surfaces as Prisma's P2028 (503) and not as a raw pg
   * error.
   */
  readonly maxWaitMs: number;
  /** The whole transaction, lock waits included. */
  readonly timeoutMs: number;
}

export const DEFAULT_CARD_LOCK_TIMING: CardLockTiming = {
  lockWaitMs: 3_000,
  maxWaitMs: 4_000,
  timeoutMs: 15_000,
};
