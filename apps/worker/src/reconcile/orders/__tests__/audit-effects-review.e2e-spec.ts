import { resolveNeedsReview } from '@repo/db';
import { effectsOf, type NotifyJob } from '@repo/shared';
import { untilSecondLook } from '../../../ton/__tests__/ton-e2e.fixtures';
import { PAST_VALID_SEC, TEST_TIMING, pinChain } from '../../../ton/__tests__/ton-e2e.harness';
import { auditEffectsStep, dbNowMs, useNotifyJobs } from './audit-effects.e2e-kit';
import { countsOf, useReconcileE2e, type Reconciler } from './reconcile-e2e.harness';

// D-64 (9), audit I-3 on the real database: a NEEDS_REVIEW resolution commits, its writer dies
// before its jobs reach Redis, and the audit-effects step queues them from the audit row: the ids
// the writer itself would have used (the shared plan), the cache deleted, nothing twice. Both
// writers: the owner's CLI (the transaction the API's OrderReviewService runs) and the
// reconciler (actorType SYSTEM, S9c SA I-3: no adminAction for it).

const r = useReconcileE2e();
const { t } = r;
const notify = useNotifyJobs(t.env.REDIS_URL);
const MIN_MS = 60_000;

/** A lost payout of a NEEDS_REVIEW order, written EXPIRED by the TON module (two looks). */
async function expiredInReview(rec: Reconciler) {
  const fixture = await r.timedOut(rec, 'LOSE');
  pinChain(t.gateway, PAST_VALID_SEC);
  await rec.confirm.check(fixture.transferId);
  await untilSecondLook(t.db, fixture.attemptId, TEST_TIMING.expiryGapSec);
  expect((await rec.confirm.check(fixture.transferId)).state).toMatchObject({
    transferStatus: 'EXPIRED',
    orderStatus: 'NEEDS_REVIEW',
  });
  return fixture;
}

const OPERATOR = {
  kind: 'operator',
  type: 'CLI',
  id: 'owner-e2e',
  ip: null,
  osUser: 'e2e',
  otpVerified: true,
} as const;
const MANUAL = {
  kind: 'MANUAL',
  evidence: 'e2e: the owner checked the wallet history, the payout never left',
  reason: 'audit effects sweep test',
} as const;

async function auditOf(orderId: string) {
  const { audits } = await r.moneyOf(orderId);
  expect(audits).toHaveLength(1);
  const [audit] = audits;
  if (audit === undefined) throw new Error('no audit row');
  return audit;
}

async function queuedAtAll(jobs: readonly NotifyJob[]): Promise<(number | null)[]> {
  return Promise.all(jobs.map((job) => notify.queuedAt(job)));
}

describe('audit effects sweep: lost effects of a review resolution (S9h)', () => {
  it("the owner's refund: the API's very ids come back, the cache goes, a second tick doubles nothing", async () => {
    const rec = await r.boot();
    const fixture = await expiredInReview(rec);
    // The API's transaction (OrderReviewService); the process dies right after the commit.
    const result = await t.db.$transaction((tx) =>
      resolveNeedsReview(tx, {
        orderId: fixture.orderId,
        to: 'FAILED',
        proof: MANUAL,
        resolver: OPERATOR,
      }),
    );
    expect(result.refund?.outcome).toBe('REFUNDED');
    const audit = await auditOf(fixture.orderId);
    expect(audit.actorType).toBe('CLI');
    await r.cacheBalance(fixture.userId);
    // What OrderAdminEffects.afterResolve would have queued (order-admin-effects.ts).
    const api = effectsOf({
      kind: 'REVIEW_RESOLVED',
      orderId: fixture.orderId,
      auditId: audit.id,
      userId: fixture.userId,
      delivered: false,
      refunded: true,
      compromisedTransferId: null,
      byOperator: true,
    });
    expect(api.notifyJobs.map((job) => job.kind)).toEqual([
      'ORDER_REFUNDED',
      'OWNER_ALERT',
      'OWNER_ALERT',
    ]);
    expect(await queuedAtAll(api.notifyJobs)).toEqual([null, null, null]);

    const { step } = auditEffectsStep(rec.moduleRef, new Set([fixture.orderId]));
    // Too fresh: the writer still has its two minutes.
    expect((await step.run({ nowMs: await dbNowMs(t.db) })).counts).toEqual({});
    expect(await queuedAtAll(api.notifyJobs)).toEqual([null, null, null]);
    expect(await r.cached(fixture.userId)).toBe(true);

    const later = (await dbNowMs(t.db)) + 3 * MIN_MS;
    expect((await step.run({ nowMs: later })).counts).toEqual({ replayed: 1 });
    const first = await queuedAtAll(api.notifyJobs);
    expect(first.every((at) => at !== null)).toBe(true);
    expect(await r.cached(fixture.userId)).toBe(false);

    expect((await step.run({ nowMs: later + 10 * MIN_MS })).counts).toEqual({ replayed: 1 });
    expect(await queuedAtAll(api.notifyJobs)).toEqual(first);
    const { ledger } = await r.moneyOf(fixture.orderId);
    expect(ledger.map((e) => e.kind)).toEqual(['PURCHASE', 'REFUND']);
  });

  it("S9c SA I-3: the reconciler's own refund (SYSTEM): notice, reviewResolved and cache, no adminAction", async () => {
    const rec = await r.boot();
    const fixture = await expiredInReview(rec);
    expect(countsOf(await rec.service.tick(), 'review')).toEqual({ refunded: 1 });
    const audit = await auditOf(fixture.orderId);
    expect(audit.actorType).toBe('SYSTEM');
    const plan = effectsOf({
      kind: 'REVIEW_RESOLVED',
      orderId: fixture.orderId,
      auditId: audit.id,
      userId: fixture.userId,
      delivered: false,
      refunded: true,
      compromisedTransferId: null,
      byOperator: false,
    });
    const adminAction: NotifyJob = { kind: 'OWNER_ALERT', alert: 'adminAction', refId: audit.id };
    // The reconciler died between its commit and its queue: nothing of it reached Redis.
    for (const job of plan.notifyJobs) await notify.drop(job);
    await r.cacheBalance(fixture.userId);

    const { step } = auditEffectsStep(rec.moduleRef, new Set([fixture.orderId]));
    const later = (await dbNowMs(t.db)) + 3 * MIN_MS;
    expect((await step.run({ nowMs: later })).counts).toEqual({ replayed: 1 });
    expect(plan.notifyJobs.map((job) => job.kind)).toEqual(['ORDER_REFUNDED', 'OWNER_ALERT']);
    expect((await queuedAtAll(plan.notifyJobs)).every((at) => at !== null)).toBe(true);
    expect(await notify.queuedAt(adminAction)).toBeNull();
    expect(await r.cached(fixture.userId)).toBe(false);
  });
});
