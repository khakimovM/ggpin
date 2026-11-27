import type { Provider } from '@nestjs/common';
import { RedisLockStore } from '../../bank-feed/client/leader-lock';
import { DEFAULT_ORDER_LOCK_TTL_MS } from '../../fulfillment/fulfill-tokens';
import { OrderLock, type LockedRun } from '../../fulfillment/order-lock';
import { RedisService } from '../../infra/redis/redis.service';

// The reconciler works on an order only under `lock:order:{id}` (D-64 (1), plan §4.1), the same
// lease the fulfill-order run holds while it pays and waits for the chain: BUSY means a run (or
// another reconciler) is on the order right now, and this tick leaves it alone (`busy` in the
// report). The lease is cooperative; the database (compare-and-set moves, row locks) stays the
// real fence. `lock:ton-wallet` is never taken here: the reconciler never signs.

/** The lock the steps take; a token so tests can hand in their own store. */
export const RECONCILE_ORDER_LOCK = Symbol('RECONCILE_ORDER_LOCK');

export interface ReconcileOrderLock {
  run<T>(orderId: string, fn: () => Promise<T>): Promise<LockedRun<T>>;
}

export const reconcileOrderLockProvider: Provider = {
  provide: RECONCILE_ORDER_LOCK,
  inject: [RedisService],
  useFactory: (redis: RedisService): ReconcileOrderLock =>
    new OrderLock(new RedisLockStore(redis.client), DEFAULT_ORDER_LOCK_TTL_MS),
};
