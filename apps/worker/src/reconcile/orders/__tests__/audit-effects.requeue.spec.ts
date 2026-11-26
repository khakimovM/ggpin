import { Logger } from '@nestjs/common';
import { notifyJobId } from '@repo/shared';
import { OrderLockUnavailableError } from '../../../fulfillment/order-lock';
import { AUDIT, NOW, ORDER, build, row, type Setup } from './audit-effects.fixtures';

// D-64 (9): the effect of a lost ORDER_RETRY is the order back in fulfillment, ONLY through the
// enqueuer, decided under the order lock (status QUEUED, no live job, abandon count below the
// max), the count read again after the lock is gone, the enqueue made outside the lease.

describe('AuditEffectsStep: ORDER_RETRY', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const retry = row({ action: 'ORDER_RETRY', after: { status: 'QUEUED' } });

  it('a still QUEUED, job-less order goes back through the enqueuer, with adminAction', async () => {
    const { step, jobs, enqueuer } = build({ page: [retry], order: { status: 'QUEUED' } });
    const report = await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).toHaveBeenCalledWith(ORDER);
    expect([...jobs.keys()]).toEqual([
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'adminAction', refId: AUDIT }),
    ]);
    expect(report).toMatchObject({ counts: { replayed: 1, requeued: 1 }, ids: [ORDER] });
  });

  it.each<[string, Setup, string]>([
    ['moved on under the lock', { status: 'PROCESSING' }, 'moved'],
    ['its job lives', { state: 'waiting' }, 'live'],
    ['its job is running', { state: 'active' }, 'live'],
    ['its re-queues are used up', { abandoned: 3 }, 'abandoned'],
    ['a run holds its lease', { busy: true }, 'busy'],
  ])('left alone when %s', async (_what, setup, outcome) => {
    const { step, enqueuer } = build({ page: [retry], order: { status: 'QUEUED' }, ...setup });
    const report = await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(report.counts[outcome]).toBe(1);
  });

  it('an order no longer QUEUED when read is not requeued at all', async () => {
    const { step, enqueuer } = build({ page: [retry], order: { status: 'PROCESSING' } });
    await step.run({ nowMs: NOW });
    expect(enqueuer.stateOf).not.toHaveBeenCalled();
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it('Redis cannot lock: the step stops (fail-closed)', async () => {
    const { step } = build({ page: [retry], order: { status: 'QUEUED' }, lockDown: true });
    await expect(step.run({ nowMs: NOW })).rejects.toBeInstanceOf(OrderLockUnavailableError);
  });

  it('the count is read under the lock: used up there, nothing is queued (even if it reads 0 later)', async () => {
    const { step, enqueuer, peek } = build({
      page: [retry],
      order: { status: 'QUEUED' },
      abandoned: [3, 0],
    });
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ abandoned: 1, replayed: 1 });
    expect(peek).toHaveBeenCalledTimes(1);
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it('and again after the lock: a job that failed for good meanwhile stops the enqueue', async () => {
    const { step, enqueuer, peek } = build({
      page: [retry],
      order: { status: 'QUEUED' },
      abandoned: [0, 3],
    });
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ abandoned: 1, replayed: 1 });
    expect(peek).toHaveBeenCalledTimes(2);
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it('a job kept by the enqueuer (someone queued it first) is counted kept, not requeued', async () => {
    const { step, enqueuer } = build({ page: [retry], order: { status: 'QUEUED' } });
    enqueuer.enqueue.mockResolvedValueOnce('keep');
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ kept: 1, replayed: 1 });
  });
});
