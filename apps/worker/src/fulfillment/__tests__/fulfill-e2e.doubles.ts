import type { LockStore } from '../../bank-feed/client/leader-lock';
import { TON_WALLET_LOCK_KEY } from '../../ton/ton-tokens';
import { TonWalletLock, type TonLease } from '../../ton/ton-lock';

// Test doubles of the fulfillment e2e suites that are not orders (those are in the fixtures).

/** An in-memory TTL-less lock store: a key is held until its owner releases it. */
export class MemoryLockStore implements LockStore {
  private readonly keys = new Map<string, string>();

  acquire(key: string, token: string): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.set(key, token);
    return Promise.resolve(true);
  }

  renew(key: string, token: string): Promise<boolean> {
    return Promise.resolve(this.keys.get(key) === token);
  }

  release(key: string, token: string): Promise<void> {
    if (this.keys.get(key) === token) this.keys.delete(key);
    return Promise.resolve();
  }
}

/** The real wallet lock on a memory store, counting every try to take it (CR m3). */
export class CountingWalletLock extends TonWalletLock {
  acquired = 0;

  constructor() {
    super(new MemoryLockStore(), TON_WALLET_LOCK_KEY, 60_000);
  }

  override acquire(): Promise<TonLease | null> {
    this.acquired += 1;
    return super.acquire();
  }
}
