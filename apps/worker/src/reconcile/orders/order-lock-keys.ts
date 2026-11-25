import { Injectable } from '@nestjs/common';
import { orderLockKey } from '../../fulfillment/order-lock';
import { RedisService } from '../../infra/redis/redis.service';

// Which `lock:order:{id}` keys exist and who holds them (phase 5 S9d, Q-17): READ ONLY (SCAN and
// GET). The reconciler never deletes, rewrites or extends a lease, not even a stuck one: its holder
// may be alive (a hung run renewing it), and a deleted lease would let a second run in while the
// first can still pay. The owner decides.
// The walk is a SCAN whose cursor goes on from tick to tick, so many keys are taken in turns. Ids
// a SCAN page returns beyond the tick's limit wait in `pending` for the next tick (S9d fix F7), at
// most MAX_PENDING of them: past that a key is seen again only on the next full SCAN cycle, which
// delays its alert by one cycle (never loses it: SCAN returns every key that exists for a whole
// cycle). `wrapped` marks the batch that ends a cycle: every key of it has been handed out.

/** The narrow part of ioredis used here (a fake in the unit tests: no write method exists). */
export interface LockKeyReader {
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    size: number,
  ): Promise<[string, string[]]>;
  get(key: string): Promise<string | null>;
}

const PREFIX = orderLockKey('');
/** A cuid order id: the only ids an alert ref may carry (refIdSubject, IdSegmentSchema). */
const ORDER_ID = /^[A-Za-z0-9]{1,40}$/;
const SCAN_COUNT = 500;
/** SCAN calls per tick at most: the walk resumes from here next tick. */
const MAX_SCAN_CALLS = 200;
/** Ids carried over to the next tick at most. */
export const MAX_PENDING = 1_000;

export interface LockKeyBatch {
  /** Order ids with a lease key, at most the asked number. */
  readonly orderIds: readonly string[];
  /** Keys under the prefix whose suffix is not an order id (logged as a count). */
  readonly malformed: number;
  /** Ids neither handed out nor kept (pending full): seen again next cycle. */
  readonly overflow: number;
  /** This batch ends a full SCAN cycle (nothing of it pending any more). */
  readonly wrapped: boolean;
}

/** Who holds a lease: its token, nobody (the key is gone), or a value no OrderLock writes. */
export type LeaseHolder =
  | { readonly kind: 'gone' }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'unnamed' };

export class OrderLockKeyWalk {
  private cursor = '0';
  private readonly pending = new Set<string>();
  private cycleDone = false;

  constructor(private readonly redis: LockKeyReader) {}

  async next(limit: number): Promise<LockKeyBatch> {
    const found = new Set<string>();
    for (const id of this.pending) {
      if (found.size >= limit) break;
      found.add(id);
      this.pending.delete(id);
    }
    // A finished cycle is reported before a new one starts, so no batch mixes two cycles.
    if (this.cycleDone) return this.batch(found, 0, 0);
    let malformed = 0;
    let overflow = 0;
    for (let call = 0; call < MAX_SCAN_CALLS && found.size < limit; call += 1) {
      const [next, keys] = await this.redis.scan(
        this.cursor,
        'MATCH',
        `${PREFIX}*`,
        'COUNT',
        SCAN_COUNT,
      );
      this.cursor = next;
      for (const key of keys) {
        const id = key.slice(PREFIX.length);
        if (!ORDER_ID.test(id)) malformed += 1;
        else if (found.has(id) || this.pending.has(id)) continue;
        else if (found.size < limit) found.add(id);
        else if (this.pending.size < MAX_PENDING) this.pending.add(id);
        else overflow += 1;
      }
      if (next === '0') {
        this.cycleDone = true;
        break;
      }
    }
    return this.batch(found, malformed, overflow);
  }

  /** GET only. A key of another type (WRONGTYPE) or an empty value is a lease nobody can name. */
  async holder(orderId: string): Promise<LeaseHolder> {
    let value: string | null;
    try {
      value = await this.redis.get(orderLockKey(orderId));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('WRONGTYPE'))
        return { kind: 'unnamed' };
      throw error;
    }
    if (value === null) return { kind: 'gone' };
    return value === '' ? { kind: 'unnamed' } : { kind: 'token', token: value };
  }

  private batch(found: Set<string>, malformed: number, overflow: number): LockKeyBatch {
    const wrapped = this.cycleDone && this.pending.size === 0;
    if (wrapped) this.cycleDone = false;
    return { orderIds: [...found], malformed, overflow, wrapped };
  }
}

/** The worker's walk over its own Redis (one per process: the cursor lives here). */
@Injectable()
export class OrderLockKeys extends OrderLockKeyWalk {
  constructor(redis: RedisService) {
    super(redis.client);
  }
}
