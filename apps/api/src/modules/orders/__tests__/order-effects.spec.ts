import { Logger } from '@nestjs/common';
import type { FulfillOrderEnqueuer } from '../../../infra/queue/fulfill-order-enqueuer';
import type { OrderNotifyProducer } from '../../notifications/order-notify.producer';
import type { WalletCache } from '../../wallet/wallet-cache';
import { EFFECT_TIMEOUT_MS, OrderEffects } from '../order-effects';

function setup(fail: { enqueue?: Error; notify?: Error } = {}) {
  const cache = { invalidate: jest.fn(() => Promise.resolve()) };
  const fulfillment = {
    enqueue: jest.fn(() => (fail.enqueue ? Promise.reject(fail.enqueue) : Promise.resolve())),
  };
  const notify = {
    enqueue: jest.fn(() => (fail.notify ? Promise.reject(fail.notify) : Promise.resolve())),
  };
  const effects = new OrderEffects(
    cache as unknown as WalletCache,
    fulfillment as unknown as FulfillOrderEnqueuer,
    notify as unknown as OrderNotifyProducer,
  );
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return { effects, cache, fulfillment, notify, error };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('OrderEffects.afterPurchase', () => {
  it('drops the balance cache, queues fulfill-order by order id and the ORDER_ACCEPTED notice', async () => {
    const { effects, cache, fulfillment, notify, error } = setup();
    await effects.afterPurchase('u1', 'o1');
    expect(cache.invalidate).toHaveBeenCalledWith('u1');
    expect(fulfillment.enqueue).toHaveBeenCalledWith('o1');
    expect(notify.enqueue).toHaveBeenCalledWith('ORDER_ACCEPTED', 'o1');
    expect(error).not.toHaveBeenCalled();
  });

  it('a failed enqueue never throws: it is logged with the order id and the notice still goes', async () => {
    const { effects, notify, error } = setup({ enqueue: new Error('Connection is closed.') });
    await expect(effects.afterPurchase('u1', 'o1')).resolves.toBeUndefined();
    expect(notify.enqueue).toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      'fulfill-order job for order o1 not queued: Connection is closed.',
    );
  });

  it('both jobs failing: two log lines, still no throw', async () => {
    const down = new Error('Stream isn’t writeable and enableOfflineQueue options is false');
    const { effects, error } = setup({ enqueue: down, notify: down });
    await expect(effects.afterPurchase('u1', 'o1')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('ORDER_ACCEPTED notice for order o1'),
    );
  });

  it('a Redis URL in an error message is scrubbed before it is logged', async () => {
    const leak = new Error('connect ECONNREFUSED redis://:hunter2@redis.internal:6379');
    const { effects, error } = setup({ enqueue: leak });
    await effects.afterPurchase('u1', 'o1');
    const [line] = error.mock.calls[0] ?? [];
    expect(String(line)).not.toContain('hunter2');
  });

  it('an enqueue that never answers is cut off at EFFECT_TIMEOUT_MS and logged as a timeout', async () => {
    jest.useFakeTimers();
    const { effects, fulfillment, notify, error } = setup();
    fulfillment.enqueue.mockReturnValue(new Promise<void>(() => undefined));
    let settled = false;
    const done = effects.afterPurchase('u1', 'o1').then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(EFFECT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await done;
    expect(notify.enqueue).toHaveBeenCalledWith('ORDER_ACCEPTED', 'o1');
    expect(error.mock.calls).toEqual([['fulfill-order job for order o1 not queued (timeout)']]);
  });

  it('every effect has the bound: a stuck notice and a stuck cache drop end the wait too', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { effects, cache, notify, error } = setup();
    cache.invalidate.mockReturnValue(new Promise<void>(() => undefined));
    notify.enqueue.mockReturnValue(new Promise<void>(() => undefined));
    const done = effects.afterPurchase('u1', 'o1');
    await jest.advanceTimersByTimeAsync(EFFECT_TIMEOUT_MS);
    await expect(done).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('ORDER_ACCEPTED notice for order o1 not queued (timeout)');
    expect(warn).toHaveBeenCalledWith('balance cache for order o1 not dropped (timeout)');
  });

  it('a job that fails after the bound is not logged twice and never becomes unhandled', async () => {
    jest.useFakeTimers();
    const { effects, fulfillment, error } = setup();
    const late = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error('late failure'));
      }, EFFECT_TIMEOUT_MS * 2);
    });
    fulfillment.enqueue.mockReturnValue(late);
    const done = effects.afterPurchase('u1', 'o1');
    await jest.advanceTimersByTimeAsync(EFFECT_TIMEOUT_MS * 3);
    await done;
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('fulfill-order job for order o1 not queued (timeout)');
  });
});
