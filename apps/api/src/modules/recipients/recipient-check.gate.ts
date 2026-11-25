import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { RECIPIENT_CHECK_WAIT_MS } from './recipient-check.client';

/** Redis key of a user's running check. Only the user id: no input, no product. */
export const recipientCheckBusyKey = (userId: string): string => `rcpt:busy:${userId}`;

// Margin over the wait, so the key outlives the request it guards even on a slow Redis reply.
const BUSY_MARGIN_MS = 1_000;

// Delete only our own value: a key that expired and was taken by a later request of the same
// user must not be released by the earlier one (same compare-and-delete as the worker's locks).
const DELETE_IF_OURS = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** A held slot: release it when the check is over (any outcome). */
export interface BusySlot {
  readonly release: () => Promise<void>;
}

/**
 * One recipient check at a time per user (audit M-1 (a)). Without it one account could keep 20
 * unique lookups in the shared FIFO queue at once and push a real customer's check past its
 * 10 s wait. The slot expires on its own (wait + 1 s) if the process dies before releasing it.
 *
 * Redis outage: `acquire` throws (500, fail closed, like the rate limiter before it); a failed
 * release is swallowed, the slot then expires by itself.
 */
@Injectable()
export class RecipientCheckGate {
  constructor(
    private readonly redis: RedisService,
    @Inject(RECIPIENT_CHECK_WAIT_MS) private readonly waitMs: number,
  ) {}

  /** The slot, or the seconds until the running check's slot expires (for Retry-After). */
  async acquire(userId: string): Promise<BusySlot | { readonly retryAfterSec: number }> {
    const key = recipientCheckBusyKey(userId);
    const token = randomBytes(16).toString('hex');
    const ttlMs = this.waitMs + BUSY_MARGIN_MS;
    const set = await this.redis.client.set(key, token, 'PX', ttlMs, 'NX');
    if (set === null) {
      const pttl = await this.redis.client.pttl(key);
      return { retryAfterSec: Math.max(1, Math.ceil((pttl > 0 ? pttl : ttlMs) / 1_000)) };
    }
    return {
      release: async () => {
        try {
          await this.redis.client.eval(DELETE_IF_OURS, 1, key, token);
        } catch {
          // Expires by itself within wait + 1 s.
        }
      },
    };
  }
}
