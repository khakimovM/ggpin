import {
  ORDER_LOCK_STUCK_AFTER_MS,
  ORDER_STALE_AFTER_MS,
  REVIEW_NOTICE_RESEND_WINDOW_MS,
  type NotifyJob,
} from '@repo/shared';
import { MAX_ABANDONED_REQUEUES } from '../../../fulfillment/abandon-counter';
import { abandonedAlertRef } from '../../../fulfillment/fulfill-settle';
import {
  attemptsOf,
  orderRow,
  transfersOf,
} from '../../../fulfillment/__tests__/fulfill-e2e.fixtures';
import { pinChain } from '../../../ton/__tests__/ton-e2e.harness';
import { episodeRef } from '../guard-ref';
import type { TickReport } from '../order-reconcile.service';
import { useSweepsE2e } from './reconcile-sweeps.e2e-kit';

// Phase 5 S9d (D-64 (3), Q-17, Q-19, plan items 3/15/24/26/27): job-less orders are queued again
// through the enqueuer, a stuck order lease is the owner's alert (the key stays), and HELD /
// NEEDS_REVIEW notices come back inside their window. Windows are measured on the database clock
// with 10 s on either side of each boundary (the test database's clock steps back by up to
// ~1.6 s every half minute). The reconciler never pays (its traps are checked after each test).

const s = useSweepsE2e();
const t = s.t;
const MARGIN_MS = 10_000;
const DIED = 'the worker died here';
const die = (): Promise<void> => Promise.reject(new Error(DIED));

function countsOf(report: TickReport, step: string): Readonly<Record<string, number>> {
  return report.steps.find((r) => r.step === step)?.counts ?? {};
}

describe('S9d: job-less PAID / QUEUED / PROCESSING orders', () => {
  it('9:50 on the database clock: untouched; 10:10: queued, and the run delivers it', async () => {
    pinChain(t.gateway, 0);
    const sweeps = await s.boot();
    const young = await s.order();
    await s.createdAgo(young.orderId, ORDER_STALE_AFTER_MS - MARGIN_MS);
    const old = await s.order();
    await s.createdAgo(old.orderId, ORDER_STALE_AFTER_MS + MARGIN_MS);

    const report = await sweeps.service.tick();
    expect(countsOf(report, 'stale')).toEqual({ enqueued: 1 });
    expect(await s.fulfillJobState(young.orderId)).toBe('none');
    expect(await s.fulfillJobState(old.orderId)).toBe('waiting');

    // The fulfill worker takes the job (its run, called by hand): one payout, DELIVERED.
    await expect(t.main.service.run(old.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect((await orderRow(t.db, old.orderId)).status).toBe('DELIVERED');
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    // Moved now: the next tick leaves it alone (the young one may have aged past 10:00 by now).
    const next = await sweeps.service.tick();
    expect(next.steps.find((r) => r.step === 'stale')?.ids ?? []).not.toContain(old.orderId);
  });

  it('a live job is never touched (active); a lease seen once is only watched', async () => {
    const sweeps = await s.boot();
    const running = await s.order();
    await s.createdAgo(running.orderId, ORDER_STALE_AFTER_MS + MARGIN_MS);
    await s.activeJob(running.orderId);
    const leased = await s.order();
    await s.createdAgo(leased.orderId, ORDER_LOCK_STUCK_AFTER_MS + MARGIN_MS);
    await s.activeJob(leased.orderId);
    await s.poisonLock(leased.orderId);

    const report = await sweeps.service.tick();
    expect(countsOf(report, 'stale')).toEqual({ live: 1, busy: 1 });
    expect(countsOf(report, 'lockStuck')).toEqual({ watching: 1 });
    expect(await s.fulfillJobState(running.orderId)).toBe('active');
    expect(await s.alertIdsLike('needsReview', `${leased.orderId}_lock_`)).toEqual([]);
  });

  it('the re-queues used up (abandon count = MAX): not queued, the owner hears; one less: queued', async () => {
    const sweeps = await s.boot();
    const stopped = await s.order();
    await s.createdAgo(stopped.orderId, ORDER_STALE_AFTER_MS + MARGIN_MS);
    await s.setAbandoned(stopped.orderId, MAX_ABANDONED_REQUEUES);
    const allowed = await s.order();
    await s.createdAgo(allowed.orderId, ORDER_STALE_AFTER_MS + MARGIN_MS);
    await s.setAbandoned(allowed.orderId, MAX_ABANDONED_REQUEUES - 1);

    const report = await sweeps.service.tick();
    expect(countsOf(report, 'stale')).toEqual({ abandoned: 1, enqueued: 1 });
    expect(await s.fulfillJobState(stopped.orderId)).toBe('none');
    expect(await s.fulfillJobState(allowed.orderId)).toBe('waiting');
    // F8: a day's episode. R1: the settle stamps the same one, so a settle's alert and this one
    // on the same day are ONE notify job (deduped), never two messages.
    const ref = episodeRef(stopped.orderId, 'abandoned', report.nowMs) ?? '';
    expect(await s.hasAlert('needsReview', ref)).toBe(true);
    expect(abandonedAlertRef(stopped.orderId, report.nowMs)).toBe(ref);
    expect(await s.hasAlert('needsReview', `${stopped.orderId}_abandoned`)).toBe(false);
    expect(await s.alertIdsLike('needsReview', `${allowed.orderId}_abandoned`)).toEqual([]);
    // Read, never counted: the settle's count is what it was.
    expect(await s.redis.get(`fulfill:abandoned:${stopped.orderId}`)).toBe(
      String(MAX_ABANDONED_REQUEUES),
    );
  });

  it('PROCESSING, a SENDING attempt without a transfer, no job: queued, the run signs once', async () => {
    pinChain(t.gateway, 0);
    const fixture = await s.order();
    t.main.hooks.afterSendingFn = die;
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).rejects.toThrow(
      DIED,
    );
    t.main.hooks.afterSendingFn = () => Promise.resolve();
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('PROCESSING');
    expect((await attemptsOf(t.db, fixture.orderId)).map((a) => a.status)).toEqual(['SENDING']);
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(0);

    // The order's last move is its PROCESSING event (now): the step is handed later clocks.
    const sweeps = await s.boot();
    const now = await s.dbNowMs();
    const early = await sweeps.stale.run({ nowMs: now + ORDER_STALE_AFTER_MS - MARGIN_MS });
    expect(early.counts).toEqual({});
    expect(await s.fulfillJobState(fixture.orderId)).toBe('none');
    const late = await sweeps.stale.run({ nowMs: now + ORDER_STALE_AFTER_MS + MARGIN_MS });
    expect(late.counts).toEqual({ enqueued: 1 });
    expect(t.gateway.callCount('sendBoc')).toBe(0);

    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('DELIVERED');
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    expect(t.executedOnChain()).toBe(1);
  });

  it('two ticks at once, the lease granted to both: the enqueuer still makes one job', async () => {
    const [a, b] = [await s.boot({ grantingLock: true }), await s.boot({ grantingLock: true })];
    const job = await s.order();
    await s.createdAgo(job.orderId, ORDER_STALE_AFTER_MS + MARGIN_MS);

    const reports = await Promise.all([a.service.tick(), b.service.tick()]);
    const all = await t.fulfillQueue.getJobs(['waiting', 'delayed', 'prioritized', 'active']);
    expect(all.filter((j) => j.id === job.orderId)).toHaveLength(1);
    const outcomes = reports.flatMap((r) => Object.keys(countsOf(r, 'stale')));
    expect(outcomes).toContain('enqueued');
    expect(outcomes.every((o) => ['enqueued', 'kept', 'live'].includes(o))).toBe(true);
  });

  it('two ticks at once on the real lease: one job; the stuck lease alerted once per hour', async () => {
    const [a, b] = [await s.boot(), await s.boot()];
    const job = await s.order();
    await s.createdAgo(job.orderId, ORDER_STALE_AFTER_MS + MARGIN_MS);
    const stuck = await s.order();
    await s.createdAgo(stuck.orderId, ORDER_LOCK_STUCK_AFTER_MS + MARGIN_MS);
    await s.poisonLock(stuck.orderId);

    const reports = await Promise.all([a.service.tick(), b.service.tick()]);
    const all = await t.fulfillQueue.getJobs(['waiting', 'delayed', 'prioritized', 'active']);
    expect(all.filter((j) => j.id === job.orderId)).toHaveLength(1);
    // The stuck one keeps its lease: no job behind it. Each replica has looked once: watched only.
    expect(all.filter((j) => j.id === stuck.orderId)).toHaveLength(0);
    expect(reports.map((r) => countsOf(r, 'lockStuck'))).toEqual([
      { watching: 1 },
      { watching: 1 },
    ]);
    // Their next looks, the same holder 30 minutes on: the owner hears it once per hour.
    const later = Math.max(...reports.map((r) => r.nowMs)) + ORDER_LOCK_STUCK_AFTER_MS;
    const looks = await Promise.all([
      a.lockStuck.run({ nowMs: later }),
      b.lockStuck.run({ nowMs: later }),
    ]);
    expect(looks.map((l) => l.counts)).toEqual([{ alerted: 1 }, { alerted: 1 }]);
    expect(await s.alertIdsLike('needsReview', `${stuck.orderId}_lock_`)).toHaveLength(1);
  });
});

describe('S9d: HELD / NEEDS_REVIEW notices sent again (Q-19)', () => {
  it('inside the window they come back under the same ids; past it, never', async () => {
    pinChain(t.gateway, 0);
    const held = await s.order({ noRoute: true });
    await expect(t.main.service.run(held.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    const review = await s.order();
    t.main.hooks.afterSendingFn = die;
    await expect(t.main.service.run(review.orderId, { finalAttempt: true })).rejects.toThrow(DIED);
    expect((await orderRow(t.db, held.orderId)).status).toBe('HELD');
    expect((await orderRow(t.db, review.orderId)).status).toBe('NEEDS_REVIEW');
    const entries = await t.db.orderEvent.findMany({
      where: {
        OR: [
          { orderId: held.orderId, to: 'HELD' },
          { orderId: review.orderId, to: 'NEEDS_REVIEW' },
        ],
      },
    });
    expect(entries).toHaveLength(2);
    const heldEvent = entries.find((e) => e.orderId === held.orderId);
    const notices: NotifyJob[] = [
      { kind: 'ORDER_REVIEW', refId: held.orderId },
      { kind: 'OWNER_ALERT', alert: 'held', refId: `${held.orderId}_${heldEvent?.id ?? ''}` },
      { kind: 'ORDER_REVIEW', refId: review.orderId },
      { kind: 'OWNER_ALERT', alert: 'needsReview', refId: review.orderId },
    ];
    // The runs' best-effort sends were lost (their process died after the commit).
    for (const notice of notices) {
      expect(await t.hasJob(notice)).toBe(true);
      await t.dropJob(notice);
    }
    const times = entries.map((e) => e.createdAt.getTime());
    const sweeps = await s.boot();

    const past = Math.max(...times) + REVIEW_NOTICE_RESEND_WINDOW_MS + MARGIN_MS;
    expect((await sweeps.notice.run({ nowMs: past })).counts).toEqual({});
    for (const notice of notices) expect(await t.hasJob(notice)).toBe(false);

    const inside = Math.min(...times) + REVIEW_NOTICE_RESEND_WINDOW_MS - MARGIN_MS;
    expect((await sweeps.notice.run({ nowMs: inside })).counts).toEqual({ resent: 2 });
    for (const notice of notices) expect(await t.hasJob(notice)).toBe(true);

    // Again: the same ids, BullMQ keeps the first jobs (nobody hears it twice).
    const queuedAt = await Promise.all(notices.map((n) => t.jobQueuedAt(n)));
    expect((await sweeps.notice.run({ nowMs: inside })).counts).toEqual({ resent: 2 });
    expect(await Promise.all(notices.map((n) => t.jobQueuedAt(n)))).toEqual(queuedAt);
  });
});
