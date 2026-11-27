import { Logger } from '@nestjs/common';
import type { LockStore } from '../../bank-feed/client/leader-lock';
import { TonLockUnavailableError, TonWalletLock } from '../ton-lock';

/** The three atomic lock steps in memory (RedisLockStore's contract). */
class MemoryLockStore implements LockStore {
  readonly keys = new Map<string, string>();
  failing = false;

  acquire(key: string, token: string): Promise<boolean> {
    if (this.failing) return Promise.reject(new Error('redis down'));
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.set(key, token);
    return Promise.resolve(true);
  }

  renew(key: string, token: string): Promise<boolean> {
    if (this.failing) return Promise.reject(new Error('redis down'));
    return Promise.resolve(this.keys.get(key) === token);
  }

  release(key: string, token: string): Promise<void> {
    if (this.failing) return Promise.reject(new Error('redis down'));
    if (this.keys.get(key) === token) this.keys.delete(key);
    return Promise.resolve();
  }
}

describe('lock:ton-wallet (one sender at a time per wallet)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a second sender gets null until the first releases', async () => {
    const store = new MemoryLockStore();
    const lock = new TonWalletLock(store, 'lock:ton-wallet', 120_000);
    const first = await lock.acquire();
    expect(first).not.toBeNull();
    expect(await lock.acquire()).toBeNull();
    expect(await first?.renew()).toBe(true);
    await first?.release();
    expect(await lock.acquire()).not.toBeNull();
  });

  it('a lost lease renews false (the DB fence still holds); release never deletes another token', async () => {
    const store = new MemoryLockStore();
    const lock = new TonWalletLock(store, 'lock:ton-wallet', 120_000);
    const lease = await lock.acquire();
    store.keys.set('lock:ton-wallet', 'someone-else');
    expect(await lease?.renew()).toBe(false);
    await lease?.release();
    expect(store.keys.get('lock:ton-wallet')).toBe('someone-else');
    expect(warn).toHaveBeenCalledWith(
      'the TON wallet lock lease was lost; the DB fence still holds',
    );
  });

  it('Redis down: acquire is fail-closed (throws), renew is false, release swallows', async () => {
    const store = new MemoryLockStore();
    const lock = new TonWalletLock(store, 'lock:ton-wallet', 120_000);
    const lease = await lock.acquire();
    store.failing = true;
    await expect(lock.acquire()).rejects.toBeInstanceOf(TonLockUnavailableError);
    expect(await lease?.renew()).toBe(false);
    await expect(lease?.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'the TON wallet lock could not be renewed (Redis); the DB fence still holds',
    );
  });
});
