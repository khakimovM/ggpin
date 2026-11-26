import type { JobStateName } from '@repo/shared';
import type { LockStore } from '../../bank-feed/client/leader-lock';
import { FulfillEnqueuer } from '../fulfill-enqueuer';
import { OrderLock, OrderLockUnavailableError, orderLockKey } from '../order-lock';

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
    return Promise.resolve(this.keys.get(key) === token);
  }

  release(key: string, token: string): Promise<void> {
    if (this.keys.get(key) === token) this.keys.delete(key);
    return Promise.resolve();
  }
}

describe('OrderLock (lock:order:{id})', () => {
  it('one run at a time per order; the lease is released after the run, even when it throws', async () => {
    const store = new MemoryLockStore();
    const lock = new OrderLock(store, 60_000);
    let inner: unknown;
    const outer = await lock.run('o1', async () => {
      inner = await lock.run('o1', () => Promise.resolve('second'));
      return 'first';
    });
    expect(outer).toEqual({ busy: false, value: 'first' });
    expect(inner).toEqual({ busy: true });
    expect(store.keys.size).toBe(0);
    await expect(lock.run('o1', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(store.keys.size).toBe(0);
    expect(orderLockKey('o1')).toBe('lock:order:o1');
  });

  it('a Redis that cannot answer is fail-closed: nothing runs', async () => {
    const store = new MemoryLockStore();
    store.failing = true;
    const fn = jest.fn(() => Promise.resolve(1));
    await expect(new OrderLock(store, 60_000).run('o1', fn)).rejects.toBeInstanceOf(
      OrderLockUnavailableError,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});

type FakeJob = { getState: () => Promise<JobStateName>; remove: jest.Mock<Promise<void>, []> };

function fakeQueue(existing: FakeJob | undefined) {
  return {
    getJob: jest.fn((_id: string) => Promise.resolve(existing)),
    add: jest.fn((_name: string, _data: object, _options: object) => Promise.resolve({})),
  };
}

function enqueuerOn(queue: ReturnType<typeof fakeQueue>): FulfillEnqueuer {
  return new FulfillEnqueuer(queue);
}

describe('FulfillEnqueuer (the worker side of decideEnqueue)', () => {
  it('adds with jobId = orderId when no job exists', async () => {
    const queue = fakeQueue(undefined);
    await expect(enqueuerOn(queue).enqueue('o1')).resolves.toBe('add');
    expect(queue.add).toHaveBeenCalledWith('fulfill', { orderId: 'o1' }, { jobId: 'o1' });
  });

  it('replaces a finished job (BullMQ would drop the add silently)', async () => {
    const job = {
      getState: () => Promise.resolve<JobStateName>('completed'),
      remove: jest.fn(() => Promise.resolve()),
    };
    const queue = fakeQueue(job);
    await expect(enqueuerOn(queue).enqueue('o1')).resolves.toBe('replace');
    expect(job.remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('keeps a live job; a finished job a worker already re-took is kept too', async () => {
    const live = {
      getState: () => Promise.resolve<JobStateName>('waiting'),
      remove: jest.fn(() => Promise.resolve()),
    };
    const queue = fakeQueue(live);
    await expect(enqueuerOn(queue).enqueue('o1')).resolves.toBe('keep');
    expect(queue.add).not.toHaveBeenCalled();

    const locked = {
      getState: () => Promise.resolve<JobStateName>('failed'),
      remove: jest.fn(() =>
        Promise.reject(
          new Error('Job o1 could not be removed because it is locked by another worker'),
        ),
      ),
    };
    const second = fakeQueue(locked);
    await expect(enqueuerOn(second).enqueue('o1')).resolves.toBe('keep');
    expect(second.add).not.toHaveBeenCalled();
  });
});
