import { BANK_FEED_HEARTBEAT_KEY } from '@repo/shared';
import type { Redis } from 'ioredis';

/** Only a cleanup bound: the API judges the age from the value (BANK_FEED_HEARTBEAT_MAX_AGE_SEC). */
const KEY_TTL_MS = 10 * 60 * 1000;

export interface BankFeedBeat {
  /** After a poll that read every source to its end (or its page cap) without an error. */
  beat(now: Date): Promise<void>;
  /** On stop: the API refuses new top-up requests at once instead of after the max age. */
  clear(): Promise<void>;
}

/**
 * `bankfeed:heartbeat` = epoch ms of the last good poll (docs/05 §4). The API's BankFeedHealth
 * reads it: old or missing means nobody reads the bank bots, so no new top-up request (503).
 */
export class RedisBankFeedBeat implements BankFeedBeat {
  constructor(private readonly redis: Redis) {}

  async beat(now: Date): Promise<void> {
    await this.redis.set(BANK_FEED_HEARTBEAT_KEY, String(now.getTime()), 'PX', KEY_TTL_MS);
  }

  async clear(): Promise<void> {
    try {
      await this.redis.del(BANK_FEED_HEARTBEAT_KEY);
    } catch {
      // Redis away: the value just ages out on the API side.
    }
  }
}
