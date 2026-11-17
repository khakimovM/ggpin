import { JOB_STATES, coreHoldNote } from '@repo/shared';
import type { Redis } from 'ioredis';
import { RedisAbandonCounter, abandonPeekOf } from '../abandon-counter';
import type { AttemptsRepository } from '../attempts.repository';
import { FulfillEnqueuer, isLiveJobState, type FulfillQueue } from '../fulfill-enqueuer';
import type { FreshAttempt } from '../fulfill-fresh';
import { FulfillReplay } from '../fulfill-replay';
import type { FulfillmentNotifier } from '../fulfillment-notifier';
import type { OrderStateRepository, RunOrder } from '../order-state.repository';

// The read-only pieces the order reconciler (phase 5 S9d) uses from the fulfillment core: the
// abandon count without counting, the job's state without touching the queue, and the resend of a
// HELD / NEEDS_REVIEW order's notices.

describe('RedisAbandonCounter.peek', () => {
  const counter = (value: string | null) => {
    const get = jest.fn().mockResolvedValue(value);
    const evalFn = jest.fn();
    return {
      peek: new RedisAbandonCounter({ get, eval: evalFn } as unknown as Redis),
      get,
      evalFn,
    };
  };

  it('reads the count of fulfill:abandoned:{id} and never counts', async () => {
    const c = counter('3');
    await expect(c.peek.peek('ordera')).resolves.toBe(3);
    expect(c.get).toHaveBeenCalledWith('fulfill:abandoned:ordera');
    expect(c.evalFn).not.toHaveBeenCalled();
  });

  it('no key: 0', async () => {
    await expect(counter(null).peek.peek('ordera')).resolves.toBe(0);
  });

  it.each(['', 'x', '-1', '1.5', '9'.repeat(20)])(
    'refuses %p (the caller does not enqueue)',
    async (v) => {
      await expect(counter(v).peek.peek('ordera')).rejects.toThrow('could not be read');
    },
  );
});

describe('abandonPeekOf (ABANDON_PEEK, S9d fix CR F6)', () => {
  it('reads through the counter and has no way to count', async () => {
    const counter = { bump: jest.fn(), peek: jest.fn().mockResolvedValue(2) };
    const reader = abandonPeekOf(counter);
    await expect(reader.peek('ordera')).resolves.toBe(2);
    expect(Object.keys(reader)).toEqual(['peek']);
    expect(counter.bump).not.toHaveBeenCalled();
  });
});

describe('FulfillEnqueuer.stateOf / isLiveJobState', () => {
  const enqueuer = (job: { getState(): Promise<string> } | undefined) => {
    const add = jest.fn();
    const queue = { getJob: jest.fn().mockResolvedValue(job), add } as unknown as FulfillQueue;
    return { enqueuer: new FulfillEnqueuer(queue), add };
  };

  it('no job: unknown; a job: its state; nothing is added', async () => {
    const none = enqueuer(undefined);
    await expect(none.enqueuer.stateOf('ordera')).resolves.toBe('unknown');
    const active = enqueuer({ getState: () => Promise.resolve('active') });
    await expect(active.enqueuer.stateOf('ordera')).resolves.toBe('active');
    expect(none.add).not.toHaveBeenCalled();
    expect(active.add).not.toHaveBeenCalled();
  });

  it('live = what the enqueue keeps (active included); finished or absent is not', () => {
    const live = JOB_STATES.filter((state) => isLiveJobState(state));
    expect(live.sort()).toEqual([
      'active',
      'delayed',
      'prioritized',
      'waiting',
      'waiting-children',
    ]);
  });
});

describe('FulfillReplay.resendHeldOrReview', () => {
  const order = (status: RunOrder['status']): RunOrder =>
    ({ id: 'ordera', userId: 'usera', status, statusReason: null }) as RunOrder;

  const replayFor = (loaded: RunOrder | null, hold: { note: string } | null = null) => {
    const send = jest.fn().mockResolvedValue(undefined);
    const orders = {
      load: jest.fn().mockResolvedValue(loaded),
      latestHold: jest
        .fn()
        .mockResolvedValue(hold === null ? null : { eventId: 'eventa', note: hold.note }),
    };
    const replay = new FulfillReplay(
      orders as unknown as OrderStateRepository,
      { latestAttemptHold: jest.fn().mockResolvedValue(null) } as unknown as AttemptsRepository,
      { afterRefund: jest.fn() } as unknown as FreshAttempt,
      { send } as unknown as FulfillmentNotifier,
    );
    return { replay, send };
  };

  it('NEEDS_REVIEW: the review notices again', async () => {
    const { replay, send } = replayFor(order('NEEDS_REVIEW'));
    await expect(replay.resendHeldOrReview('ordera')).resolves.toBe('RESENT');
    expect(send).toHaveBeenCalledWith([
      { kind: 'ORDER_REVIEW', orderId: 'ordera' },
      { kind: 'ALERT', alert: 'needsReview', refId: 'ordera' },
    ]);
  });

  it.each(['PAID', 'QUEUED', 'PROCESSING', 'DELIVERED', 'REFUNDED', 'FAILED'] as const)(
    "%s: moved, nothing sent (the DELIVERED notice is not the resend step's)",
    async (status) => {
      const { replay, send } = replayFor(order(status));
      await expect(replay.resendHeldOrReview('ordera')).resolves.toBe('MOVED');
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('HELD by a core hold: its notices again, RESENT', async () => {
    const { replay, send } = replayFor(order('HELD'), { note: coreHoldNote('ADAPTER_ERROR', 'x') });
    await expect(replay.resendHeldOrReview('ordera')).resolves.toBe('RESENT');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('CR F5: HELD by a hold the core cannot name: nothing sent, UNNAMED (never RESENT)', async () => {
    const { replay, send } = replayFor(order('HELD'), { note: 'an operator note' });
    const warn = jest.spyOn(replay['logger'], 'warn').mockImplementation(() => undefined);
    await expect(replay.resendHeldOrReview('ordera')).resolves.toBe('UNNAMED');
    expect(send).not.toHaveBeenCalled();
    // The step logs it (once); the resend itself stays quiet.
    expect(warn).not.toHaveBeenCalled();
  });

  it('no such order: missing', async () => {
    await expect(replayFor(null).replay.resendHeldOrReview('ordera')).resolves.toBe('MISSING');
  });
});
