import type { Redis } from 'ioredis';

// How many times a PAID / QUEUED order's fulfill-order job failed for good and was put back
// (CR m8). Redis only: a database column needs a migration (not in this round) and the count is a
// circuit breaker, not a fact about money. Losing it (Redis flushed) only allows a few more
// re-queues; it never pays, since the run itself re-checks everything under the order lock.

/** Re-queues allowed per order inside the window; one more final failure alerts the owner. */
export const MAX_ABANDONED_REQUEUES = 3;
/** The window of the count, from the first final failure (a day: the owner reads it by then). */
export const ABANDON_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const ABANDON_COUNTER = Symbol('ABANDON_COUNTER');

export interface AbandonCounter {
  /** This final failure counted; the number of final failures in the window, this one included. */
  bump(orderId: string): Promise<number>;
}

export function abandonKey(orderId: string): string {
  return `fulfill:abandoned:${orderId}`;
}

// INCR and the expiry in one step: a crash between two commands cannot leave a count for ever.
const BUMP = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

export class RedisAbandonCounter implements AbandonCounter {
  constructor(private readonly redis: Redis) {}

  async bump(orderId: string): Promise<number> {
    const count: unknown = await this.redis.eval(
      BUMP,
      1,
      abandonKey(orderId),
      String(ABANDON_WINDOW_MS),
    );
    if (typeof count !== 'number' || !Number.isSafeInteger(count)) {
      throw new Error('the abandoned-job count could not be read');
    }
    return count;
  }
}
