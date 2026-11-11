import type { LockStore } from '../leader-lock';

/** In-memory TTL lock with a hand-moved clock: what Redis SET NX PX / PEXPIRE / DEL do. */
export class MemoryLockStore implements LockStore {
  nowMs = 0;
  failing = false;
  private readonly keys = new Map<string, { token: string; until: number }>();

  private live(key: string) {
    const entry = this.keys.get(key);
    if (entry !== undefined && entry.until <= this.nowMs) {
      this.keys.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Puts another holder's token on the key (a takeover the test stages). */
  force(key: string, token: string, ttlMs: number): void {
    this.keys.set(key, { token, until: this.nowMs + ttlMs });
  }

  holder(key: string): string | null {
    return this.live(key)?.token ?? null;
  }

  acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (this.failing) return Promise.reject(new Error('redis down'));
    if (this.live(key) !== undefined) return Promise.resolve(false);
    this.keys.set(key, { token, until: this.nowMs + ttlMs });
    return Promise.resolve(true);
  }

  renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (this.failing) return Promise.reject(new Error('redis down'));
    const entry = this.live(key);
    if (entry?.token !== token) return Promise.resolve(false);
    entry.until = this.nowMs + ttlMs;
    return Promise.resolve(true);
  }

  release(key: string, token: string): Promise<void> {
    if (this.live(key)?.token === token) this.keys.delete(key);
    return Promise.resolve();
  }
}
