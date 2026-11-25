import { Logger } from '@nestjs/common';
import { ORDER_STALE_AFTER_MS, RECONCILE_BATCH_LIMIT, type JobStateName } from '@repo/shared';
import type { AbandonPeek } from '../../../fulfillment/abandon-counter';
import type { FulfillEnqueuer } from '../../../fulfillment/fulfill-enqueuer';
import { OrderLockUnavailableError, type LockedRun } from '../../../fulfillment/order-lock';
import type { OrderSweepsRepository, SweepCursor } from '../order-sweeps.repository';
import type { ReconcileNotifier } from '../reconcile-notifier';
import type { ReconcileOrderLock } from '../reconcile-order-lock';
import { StaleOrdersStep } from '../stale-orders.step';

// D-64 (3): a job-less PAID / QUEUED / PROCESSING order is queued again through the enqueuer only,
// never while its job lives, never past the abandon count, never while a run holds its lease.

const NOW = 1_790_000_000_000;
const DAY_MS = 86_400_000;
const DAY = Math.floor(NOW / DAY_MS);
const row = (id: string): SweepCursor => ({ id, createdAt: new Date(NOW - 3_600_000) });

interface Setup {
  readonly page?: SweepCursor[];
  readonly stale?: boolean;
  readonly state?: JobStateName;
  /** The count the peeks read, in turn (the last one repeats). */
  readonly abandoned?: number | Error | readonly number[];
  readonly busy?: boolean;
  readonly lockDown?: boolean;
}

function build(setup: Setup = {}) {
  const repository = {
    stalePage: jest.fn().mockResolvedValue(setup.page ?? [row('ordera')]),
    isStale: jest.fn().mockResolvedValue(setup.stale ?? true),
  };
  const enqueuer = {
    stateOf: jest.fn().mockResolvedValue(setup.state ?? 'unknown'),
    enqueue: jest.fn().mockResolvedValue('add'),
  };
  const peek = jest.fn<Promise<number>, [string]>();
  const counts = setup.abandoned;
  if (counts instanceof Error) peek.mockRejectedValue(counts);
  else if (typeof counts === 'object') {
    for (const count of counts) peek.mockResolvedValueOnce(count);
    peek.mockResolvedValue(counts[counts.length - 1] ?? 0);
  } else peek.mockResolvedValue(counts ?? 0);
  // The reconciler's reader cannot count: no bump exists on it (ABANDON_PEEK).
  const counter: AbandonPeek = { peek };
  const notifier = { alert: jest.fn().mockResolvedValue(true) };
  const inLock: string[] = [];
  const lock: ReconcileOrderLock = {
    run: async <T>(orderId: string, fn: () => Promise<T>): Promise<LockedRun<T>> => {
      if (setup.lockDown === true) throw new OrderLockUnavailableError();
      if (setup.busy === true) return { busy: true };
      inLock.push(orderId);
      const value = await fn();
      inLock.pop();
      return { busy: false, value };
    },
  };
  // The enqueue must come after the lease is gone (the new job must not meet our own lease).
  enqueuer.enqueue.mockImplementation(() => {
    expect(inLock).toEqual([]);
    return Promise.resolve('add');
  });
  const step = new StaleOrdersStep(
    repository as unknown as OrderSweepsRepository,
    enqueuer as unknown as FulfillEnqueuer,
    notifier as unknown as ReconcileNotifier,
    counter,
    lock,
  );
  return { step, repository, enqueuer, peek, notifier };
}

describe('StaleOrdersStep', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks for orders unchanged since now - ORDER_STALE_AFTER_MS (database clock)', async () => {
    const { step, repository } = build();
    await step.run({ nowMs: NOW });
    const before = new Date(NOW - ORDER_STALE_AFTER_MS);
    expect(repository.stalePage).toHaveBeenCalledWith(before, null, RECONCILE_BATCH_LIMIT);
    expect(repository.isStale).toHaveBeenCalledWith('ordera', before);
  });

  it('a job-less stale order is queued again through the enqueuer', async () => {
    const { step, enqueuer } = build();
    const report = await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).toHaveBeenCalledWith('ordera');
    expect(report).toEqual({ step: 'stale', counts: { enqueued: 1 }, ids: ['ordera'] });
  });

  it.each(['waiting', 'delayed', 'prioritized', 'active', 'waiting-children'] as const)(
    'a %s job: left alone',
    async (state) => {
      const { step, enqueuer } = build({ state });
      const report = await step.run({ nowMs: NOW });
      expect(enqueuer.enqueue).not.toHaveBeenCalled();
      expect(report.counts).toEqual({ live: 1 });
    },
  );

  it.each(['completed', 'failed', 'unknown'] as const)('a %s job: queued again', async (state) => {
    const { step, enqueuer } = build({ state });
    await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('the re-queues used up (abandon count = MAX): not queued, <id>_abandoned_<day> (F8)', async () => {
    const { step, enqueuer, notifier } = build({ abandoned: 3 });
    const report = await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(notifier.alert).toHaveBeenCalledWith('needsReview', `ordera_abandoned_${String(DAY)}`);
    expect(report.counts).toEqual({ abandoned: 1 });
  });

  it('F8: one alert id a day: the same all day, a new one the next day (never silent)', async () => {
    const { step, notifier } = build({ abandoned: 3 });
    const start = DAY * DAY_MS;
    await step.run({ nowMs: start });
    await step.run({ nowMs: start + DAY_MS - 1 });
    await step.run({ nowMs: start + DAY_MS });
    expect(notifier.alert.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      `ordera_abandoned_${String(DAY)}`,
      `ordera_abandoned_${String(DAY)}`,
      `ordera_abandoned_${String(DAY + 1)}`,
    ]);
  });

  it('one below the count: queued again (the count read twice, never counted)', async () => {
    const { step, enqueuer, peek } = build({ abandoned: 2 });
    await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledTimes(2);
  });

  it('L-1 TOCTOU: a settle counted the last failure after the decision: not queued, alerted', async () => {
    const { step, enqueuer, notifier } = build({ abandoned: [2, 3] });
    const report = await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(notifier.alert).toHaveBeenCalledWith('needsReview', `ordera_abandoned_${String(DAY)}`);
    expect(report.counts).toEqual({ abandoned: 1 });
  });

  it('an unreadable abandon count: not queued (fail-closed), the next order goes on', async () => {
    const { step, enqueuer } = build({
      abandoned: new Error('the abandoned-job count could not be read'),
      page: [row('ordera'), row('orderb')],
    });
    const report = await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(report.counts).toEqual({ failed: 2 });
  });

  it('moved since the list was read (checked again under the lock): left alone', async () => {
    const { step, enqueuer } = build({ stale: false });
    const report = await step.run({ nowMs: NOW });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(enqueuer.stateOf).not.toHaveBeenCalled();
    expect(report.counts).toEqual({ moved: 1 });
  });

  it('a run holds the lease: busy, nothing read or queued', async () => {
    const { step, enqueuer, repository } = build({ busy: true });
    const report = await step.run({ nowMs: NOW });
    expect(repository.isStale).not.toHaveBeenCalled();
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    expect(report.counts).toEqual({ busy: 1 });
  });

  it('Redis cannot give the lock: the step stops (fail-closed)', async () => {
    const { step, enqueuer } = build({ lockDown: true });
    await expect(step.run({ nowMs: NOW })).rejects.toBeInstanceOf(OrderLockUnavailableError);
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });

  it('a kept enqueue (someone queued it first) is counted, not reported as decided', async () => {
    const { step, enqueuer } = build();
    enqueuer.enqueue.mockResolvedValue('keep');
    const report = await step.run({ nowMs: NOW });
    expect(report).toEqual({ step: 'stale', counts: { kept: 1 }, ids: [] });
  });

  it('walks on from a full page and starts over after a short one', async () => {
    const full = Array.from({ length: RECONCILE_BATCH_LIMIT }, (_, i) => row(`order${String(i)}`));
    const { step, repository } = build({ page: full, state: 'waiting' });
    await step.run({ nowMs: NOW });
    repository.stalePage.mockResolvedValue([]);
    await step.run({ nowMs: NOW });
    await step.run({ nowMs: NOW });
    const cursors = repository.stalePage.mock.calls.map((call: unknown[]) => call[1]);
    expect(cursors).toEqual([null, full[full.length - 1], null]);
  });
});
