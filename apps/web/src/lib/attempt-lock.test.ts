import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptLockName, withAttemptLock } from './attempt-lock';

type Grant = { name: string } | null;

function installLocks(
  grant: (name: string) => Grant | 'throws',
  seen: Array<{ name: string; options: unknown }> = [],
) {
  const request = vi.fn(
    (name: string, options: unknown, callback: (lock: Grant) => unknown): Promise<unknown> => {
      seen.push({ name, options });
      const granted = grant(name);
      if (granted === 'throws')
        return Promise.reject(new DOMException('insecure', 'SecurityError'));
      return Promise.resolve(callback(granted));
    },
  );
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  return request;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
});

describe('withAttemptLock', () => {
  it('is named after the user, like the storage key of the record', () => {
    expect(attemptLockName('u1')).toBe('ggpin:order-attempt:u1');
  });

  it('holds a lock without waiting (ifAvailable) while the task runs, and returns its result', async () => {
    const seen: Array<{ name: string; options: unknown }> = [];
    installLocks((name) => ({ name }), seen);
    const task = vi.fn(() => Promise.resolve('paid'));
    const onBusy = vi.fn(() => 'busy');
    await expect(withAttemptLock('u1', task, onBusy)).resolves.toBe('paid');
    expect(seen).toEqual([{ name: 'ggpin:order-attempt:u1', options: { ifAvailable: true } }]);
    expect(task).toHaveBeenCalledTimes(1);
    expect(onBusy).not.toHaveBeenCalled();
  });

  it('a lock that is taken means a payment is on its way elsewhere: the task does NOT run', async () => {
    installLocks(() => null);
    const task = vi.fn(() => Promise.resolve('paid'));
    await expect(withAttemptLock('u1', task, () => 'busy')).resolves.toBe('busy');
    expect(task).not.toHaveBeenCalled();
  });

  it('the lock is held for the whole task, not just its start', async () => {
    let held = false;
    let release: () => void = () => undefined;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_n: string, _o: unknown, callback: (lock: Grant) => Promise<unknown>) => {
          held = true;
          return callback({ name: 'x' }).finally(() => {
            held = false;
          });
        },
      },
    });
    const run = withAttemptLock(
      'u1',
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('done');
        }),
      () => 'busy',
    );
    await Promise.resolve();
    expect(held).toBe(true);
    release();
    await expect(run).resolves.toBe('done');
    expect(held).toBe(false);
  });

  it('without Web Locks the task just runs', async () => {
    expect(navigator.locks).toBeUndefined();
    const task = vi.fn(() => Promise.resolve('paid'));
    await expect(withAttemptLock('u1', task, () => 'busy')).resolves.toBe('paid');
  });

  it('a lock that cannot even be asked for (a restricted context) lets the task run once', async () => {
    installLocks(() => 'throws');
    const task = vi.fn(() => Promise.resolve('paid'));
    await expect(withAttemptLock('u1', task, () => 'busy')).resolves.toBe('paid');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('what the task itself throws is passed on, and the task is not run a second time', async () => {
    installLocks((name) => ({ name }));
    const task = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(withAttemptLock('u1', task, () => 'busy')).rejects.toThrow('boom');
    expect(task).toHaveBeenCalledTimes(1);
  });
});
