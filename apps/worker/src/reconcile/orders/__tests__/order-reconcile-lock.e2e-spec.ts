import { ORDER_LOCK_STUCK_AFTER_MS } from '@repo/shared';
import { FulfillOrderProcessor } from '../../../fulfillment/fulfill-order.processor';
import { OrderStateRepository } from '../../../fulfillment/order-state.repository';
import { orderRow } from '../../../fulfillment/__tests__/fulfill-e2e.fixtures';
import { episodeRef } from '../guard-ref';
import type { TickReport } from '../order-reconcile.service';
import { useSweepsE2e } from './reconcile-sweeps.e2e-kit';

// Phase 5 S9d, Q-17, fix round F1/F4: a poisoned `lock:order:{id}` is the owner's needsReview alert
// `<orderId>_lock_<hour>` once the SAME holder has kept an unchanged order for
// ORDER_LOCK_STUCK_AFTER_MS (two looks of one process), whatever the order's job does; a run's
// last retry that met the lease ends BUSY and is not queued again. The key is never touched.
// Real Postgres (scratch `_test`) + Redis DB 15 through the e2e lock; later looks are handed a
// later database clock (the order's own events are written now).

const s = useSweepsE2e();
const t = s.t;
const MARGIN_MS = 10_000;
const STUCK = ORDER_LOCK_STUCK_AFTER_MS;

function countsOf(report: TickReport, step: string): Readonly<Record<string, number>> {
  return report.steps.find((r) => r.step === step)?.counts ?? {};
}

async function queuedOrder(): Promise<string> {
  const { orderId } = await s.order();
  await t.main.moduleRef.get(OrderStateRepository).advance(orderId, 'PAID');
  expect((await orderRow(t.db, orderId)).status).toBe('QUEUED');
  return orderId;
}

describe('S9d F1: a QUEUED order behind a poisoned lease', () => {
  it('the last retry meets the lease: BUSY, and the end-of-run re-check queues nothing', async () => {
    const orderId = await queuedOrder();
    await s.poisonLock(orderId);
    const processor = new FulfillOrderProcessor(t.main.service, t.main.enqueuer);
    const returnvalue = await t.main.service.run(orderId, { finalAttempt: true });
    expect(returnvalue).toBe('BUSY');
    // BullMQ's completed event of that job (its last attempt).
    const job = { id: orderId, data: { orderId }, attemptsMade: 5, opts: { attempts: 5 } };
    await processor.onCompleted({ ...job, returnvalue });
    expect(await s.fulfillJobState(orderId)).toBe('none');
    expect((await orderRow(t.db, orderId)).status).toBe('QUEUED');
  });

  it('a job that keeps meeting BUSY (alive): the same holder 30 min on is one _lock_ alert', async () => {
    const sweeps = await s.boot();
    const orderId = await queuedOrder();
    const token = await s.poisonLock(orderId);
    await s.activeJob(orderId);
    const now = await s.dbNowMs();

    const first = await sweeps.lockStuck.run({ nowMs: now + STUCK + MARGIN_MS });
    expect(first.counts).toEqual({ watching: 1 });
    const late = now + 2 * STUCK + 2 * MARGIN_MS;
    const second = await sweeps.lockStuck.run({ nowMs: late });
    expect(second).toEqual({ step: 'lockStuck', counts: { alerted: 1 }, ids: [orderId] });
    expect(await s.hasAlert('needsReview', episodeRef(orderId, 'lock', late) ?? '')).toBe(true);
    expect(await s.alertIdsLike('needsReview', `${orderId}_lock_`)).toHaveLength(1);
    expect(await s.hasAlert('needsReview', orderId)).toBe(false);
    // Nothing touched: the lease, the job.
    expect(await s.lockValue(orderId)).toBe(token);
    expect(await s.fulfillJobState(orderId)).toBe('active');
  });
});

describe('S9d: a stuck order lease (Q-17)', () => {
  it('one look watches; the same holder later alerts <id>_lock_<hour>, deduped, the key stays', async () => {
    const sweeps = await s.boot();
    const stuck = await s.order();
    await s.createdAgo(stuck.orderId, STUCK + MARGIN_MS);
    const recent = await s.order();
    await s.createdAgo(recent.orderId, STUCK - MARGIN_MS);
    const token = await s.poisonLock(stuck.orderId);
    await s.poisonLock(recent.orderId);

    const first = await sweeps.service.tick();
    // The recent order is not unchanged for 30 min yet: not counted. Neither alerted on one look.
    expect(countsOf(first, 'lockStuck')).toEqual({ watching: 1 });
    // Both are past the stale window, but the lease is held: the job-less sweep stays out.
    expect(countsOf(first, 'stale')).toEqual({ busy: 2 });
    expect(await s.alertIdsLike('needsReview', `${stuck.orderId}_`)).toEqual([]);

    // The recent one's lease changes hands (a run that began); the stuck one's does not.
    await s.poisonLock(recent.orderId);
    const late = first.nowMs + STUCK;
    const second = await sweeps.lockStuck.run({ nowMs: late });
    expect(second.counts).toEqual({ alerted: 1, watching: 1 });
    expect(second.ids).toEqual([stuck.orderId]);
    const ref = episodeRef(stuck.orderId, 'lock', late) ?? '';
    expect(await s.hasAlert('needsReview', ref)).toBe(true);
    // The plain id belongs to the order's real NEEDS_REVIEW alert: never taken by this one.
    expect(await s.hasAlert('needsReview', stuck.orderId)).toBe(false);
    expect(await s.alertIdsLike('needsReview', `${recent.orderId}_lock_`)).toEqual([]);

    // Again within the hour: the same id (one message).
    expect((await sweeps.lockStuck.run({ nowMs: late })).counts).toEqual({
      alerted: 1,
      watching: 1,
    });
    expect(await s.alertIdsLike('needsReview', `${stuck.orderId}_lock_`)).toHaveLength(1);
    // Never deleted, never rewritten, nothing queued past it.
    expect(await s.lockValue(stuck.orderId)).toBe(token);
    expect(await s.fulfillJobState(stuck.orderId)).toBe('none');
  });
});
