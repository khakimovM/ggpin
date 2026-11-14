import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { LockStore } from '../bank-feed/client/leader-lock';

// `lock:order:{id}` (rules/45 step 1, plan 6.6 step 1): one run per order at a time across worker
// replicas. Cooperative only: the real fence is the database (compare-and-set status moves, one
// live attempt per order, one unresolved TON transfer per wallet), so a lost lease can never pay
// twice. A Redis that cannot answer is fail-closed: OrderLockUnavailableError, nothing runs, the
// job retries.

export class OrderLockUnavailableError extends Error {
  constructor() {
    super('the order lock cannot be taken: Redis is not answering (nothing was done)');
    this.name = 'OrderLockUnavailableError';
  }
}

export type LockedRun<T> = { readonly busy: true } | { readonly busy: false; readonly value: T };

export function orderLockKey(orderId: string): string {
  return `lock:order:${orderId}`;
}

export class OrderLock {
  private readonly logger = new Logger(OrderLock.name);

  constructor(
    private readonly store: LockStore,
    private readonly ttlMs: number,
  ) {}

  /** Runs `fn` while holding the order's lease; `busy` when another run holds it. */
  async run<T>(orderId: string, fn: () => Promise<T>): Promise<LockedRun<T>> {
    const key = orderLockKey(orderId);
    const token = randomBytes(16).toString('hex');
    let taken: boolean;
    try {
      taken = await this.store.acquire(key, token, this.ttlMs);
    } catch {
      throw new OrderLockUnavailableError();
    }
    if (!taken) return { busy: true };
    // Renewed while the run lasts (a TON confirmation waits minutes); unref'd so a pending timer
    // never keeps a stopping worker alive.
    const timer = setInterval(() => void this.renew(key, token), Math.floor(this.ttlMs / 3));
    timer.unref();
    try {
      return { busy: false, value: await fn() };
    } finally {
      clearInterval(timer);
      try {
        await this.store.release(key, token);
      } catch {
        // Redis away: the TTL frees the key.
      }
    }
  }

  private async renew(key: string, token: string): Promise<void> {
    try {
      if (!(await this.store.renew(key, token, this.ttlMs))) {
        this.logger.warn('an order lock lease was lost; the database fence still holds');
      }
    } catch {
      this.logger.warn(
        'an order lock could not be renewed (Redis); the database fence still holds',
      );
    }
  }
}
