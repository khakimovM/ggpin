import { LeaderLock } from '../leader-lock';
import { MemoryLockStore } from './memory-lock-store';

const KEY = 'lock:bank-feed';
const TTL = 30_000;

describe('LeaderLock', () => {
  it('a second worker does not get the lock while the leader renews it', async () => {
    const store = new MemoryLockStore();
    const a = new LeaderLock(store, KEY, TTL);
    const b = new LeaderLock(store, KEY, TTL);
    expect(a.token).not.toBe(b.token);
    expect(await a.hold()).toBe(true);
    for (let t = 10_000; t <= 120_000; t += 10_000) {
      store.nowMs = t;
      expect(await a.hold()).toBe(true);
      expect(await b.hold()).toBe(false);
    }
    expect(store.holder(KEY)).toBe(a.token);
  });

  it('a dead leader (no renewals) loses it after the TTL and the standby takes it', async () => {
    const store = new MemoryLockStore();
    const a = new LeaderLock(store, KEY, TTL);
    const b = new LeaderLock(store, KEY, TTL);
    await a.hold();
    store.nowMs = TTL - 1;
    expect(await b.hold()).toBe(false);
    store.nowMs = TTL;
    expect(await b.hold()).toBe(true);
    // The old leader wakes up: its renew fails, so it knows to disconnect.
    expect(await a.hold()).toBe(false);
    expect(a.isHeld).toBe(false);
    expect(store.holder(KEY)).toBe(b.token);
  });

  it('release frees only our own lock', async () => {
    const store = new MemoryLockStore();
    const a = new LeaderLock(store, KEY, TTL);
    const b = new LeaderLock(store, KEY, TTL);
    await a.hold();
    await b.release();
    expect(store.holder(KEY)).toBe(a.token);
    await a.release();
    expect(store.holder(KEY)).toBeNull();
    expect(await b.hold()).toBe(true);
  });

  it('a Redis error means "not held" (fail closed: no second connection)', async () => {
    const store = new MemoryLockStore();
    const a = new LeaderLock(store, KEY, TTL);
    await a.hold();
    store.failing = true;
    expect(await a.hold()).toBe(false);
    await expect(a.release()).resolves.toBeUndefined();
  });

  it('D-52 local lease: fresh only while the last CONFIRMED renewal (as sent) is younger than TTL - margin', async () => {
    const store = new MemoryLockStore();
    let now = 0;
    const lock = new LeaderLock(store, KEY, TTL, 15_000, () => now);
    expect(lock.isFresh()).toBe(false);
    await lock.hold();
    expect(lock.isFresh()).toBe(true);
    now = 14_999;
    expect(lock.isFresh()).toBe(true);
    now = 15_000; // no confirmed renewal for 15 s: stop before the key (30 s) can expire
    expect(lock.isFresh()).toBe(false);
    // A renewal that hangs proves nothing: the lease keeps ageing until it is answered.
    let answer: (ok: boolean) => void = () => undefined;
    const hanging = new LeaderLock(
      {
        acquire: () => Promise.resolve(true),
        renew: () => new Promise<boolean>((resolve) => (answer = resolve)),
        release: () => Promise.resolve(),
      },
      KEY,
      TTL,
      15_000,
      () => now,
    );
    now = 100_000;
    await hanging.hold();
    now = 105_000;
    const renewal = hanging.hold();
    now = 116_000;
    expect(hanging.isFresh()).toBe(false);
    answer(true);
    await renewal;
    expect(hanging.isFresh()).toBe(true); // counted from 105 000, when it was sent
    now = 120_000;
    expect(hanging.isFresh()).toBe(false);
    await hanging.release();
    expect(hanging.isFresh()).toBe(false);
  });

  it('the default margin is half the TTL', async () => {
    let now = 0;
    const lock = new LeaderLock(new MemoryLockStore(), KEY, TTL, undefined, () => now);
    await lock.hold();
    now = 14_999;
    expect(lock.isFresh()).toBe(true);
    now = 15_000;
    expect(lock.isFresh()).toBe(false);
  });
});
