import { RECONCILE_BATCH_LIMIT, type NotifyJob } from '@repo/shared';
import {
  auditEffectsStep,
  dbNowMs,
  fakeTargetId,
  insertAudit,
  useNotifyJobs,
} from './audit-effects.e2e-kit';
import { useSweepsE2e } from './reconcile-sweeps.e2e-kit';

// D-64 (9), audit I-3 on the real database and Redis: which audit rows the sweep reads (the window
// [now - 24 h, now - 2 min] on the database clock; each action on its own target type only), and
// what it queues for them: adminAction for an owner's fx:set / ton:hint, tonWalletCompromised for
// a SENT_ELSEWHERE resolution, and an ORDER_RETRY order still QUEUED back to fulfillment through
// the enqueuer only (one job, never past the abandon count).

const s = useSweepsE2e();
const { t } = s;
const notify = useNotifyJobs(t.env.REDIS_URL);
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

const adminAction = (auditId: string): NotifyJob => ({
  kind: 'OWNER_ALERT',
  alert: 'adminAction',
  refId: auditId,
});

async function queuedOrder(): Promise<{ orderId: string; userId: string }> {
  const fixture = await s.order();
  await t.db.order.update({ where: { id: fixture.orderId }, data: { status: 'QUEUED' } });
  return fixture;
}

describe('audit effects sweep (S9h)', () => {
  it('replays only rows inside [now - 24 h, now - 2 min]: a 25 h old or a fresh row is left alone', async () => {
    const { moduleRef } = await s.boot();
    const targets = new Set<string>();
    const fx = async (ageMs: number): Promise<string> => {
      const targetId = fakeTargetId('fx');
      targets.add(targetId);
      return insertAudit(t.db, { action: 'FX_SET', targetType: 'FxRate', targetId, ageMs });
    };
    const old = await fx(25 * HOUR_MS);
    const edge = await fx(23 * HOUR_MS);
    const settled = await fx(3 * MIN_MS);
    const fresh = await fx(MIN_MS / 2);
    const { step } = auditEffectsStep(moduleRef, targets);
    const report = await step.run({ nowMs: await dbNowMs(t.db) });
    expect(report.counts).toEqual({ replayed: 2 });
    expect(await notify.queuedAt(adminAction(old))).toBeNull();
    expect(await notify.queuedAt(adminAction(edge))).not.toBeNull();
    expect(await notify.queuedAt(adminAction(settled))).not.toBeNull();
    expect(await notify.queuedAt(adminAction(fresh))).toBeNull();
  });

  it('reads each action on its own target type only; ton:hint gets adminAction', async () => {
    const { moduleRef } = await s.boot();
    const transferId = fakeTargetId('tt');
    const strayId = fakeTargetId('st');
    const hint = await insertAudit(t.db, {
      action: 'TON_TX_HINT',
      targetType: 'TonTransfer',
      targetId: transferId,
      ageMs: 5 * MIN_MS,
    });
    const stray = await insertAudit(t.db, {
      action: 'ORDER_RETRY',
      targetType: 'FxRate',
      targetId: strayId,
      ageMs: 5 * MIN_MS,
    });
    const { step, repository } = auditEffectsStep(moduleRef, new Set([transferId, strayId]));
    const now = await dbNowMs(t.db);
    const rows = await repository.page(new Date(now - 24 * HOUR_MS), new Date(now), null, 100);
    expect(rows.map((row) => row.id)).toEqual([hint]);
    expect((await step.run({ nowMs: now })).counts).toEqual({ replayed: 1 });
    expect(await notify.queuedAt(adminAction(hint))).not.toBeNull();
    expect(await notify.queuedAt(adminAction(stray))).toBeNull();
  });

  it('SENT_ELSEWHERE: tonWalletCompromised (refId = transfer), no customer notice without a refund', async () => {
    const { moduleRef } = await s.boot();
    const fixture = await s.order();
    const transferId = fakeTargetId('tr');
    const auditId = await insertAudit(t.db, {
      action: 'ORDER_REVIEW_RESOLVE',
      targetType: 'Order',
      targetId: fixture.orderId,
      after: {
        proof: { kind: 'TON_UNMATCHED_RESOLVED', finding: 'SENT_ELSEWHERE', transferId },
        refund: null,
      },
      ageMs: 5 * MIN_MS,
    });
    const { step } = auditEffectsStep(moduleRef, new Set([fixture.orderId]));
    expect((await step.run({ nowMs: await dbNowMs(t.db) })).counts).toEqual({ replayed: 1 });
    const compromised: NotifyJob = {
      kind: 'OWNER_ALERT',
      alert: 'tonWalletCompromised',
      refId: transferId,
    };
    expect(await notify.queuedAt(compromised)).not.toBeNull();
    expect(
      await notify.queuedAt({
        kind: 'OWNER_ALERT',
        alert: 'reviewResolved',
        refId: `${fixture.orderId}_${auditId}`,
      }),
    ).not.toBeNull();
    expect(await notify.queuedAt(adminAction(auditId))).not.toBeNull();
    expect(await notify.queuedAt({ kind: 'ORDER_REFUNDED', refId: fixture.orderId })).toBeNull();
    expect(await notify.queuedAt({ kind: 'ORDER_DELIVERED', refId: fixture.orderId })).toBeNull();
  });

  it('ORDER_RETRY of a QUEUED, job-less order: one fulfill-order job through the enqueuer, once', async () => {
    const { moduleRef } = await s.boot();
    const fixture = await queuedOrder();
    const auditId = await insertAudit(t.db, {
      action: 'ORDER_RETRY',
      targetType: 'Order',
      targetId: fixture.orderId,
      after: { status: 'QUEUED' },
      ageMs: 5 * MIN_MS,
    });
    expect(await s.fulfillJobState(fixture.orderId)).toBe('none');
    const { step } = auditEffectsStep(moduleRef, new Set([fixture.orderId]));
    const now = await dbNowMs(t.db);
    expect(await step.run({ nowMs: now })).toMatchObject({
      counts: { replayed: 1, requeued: 1 },
      ids: [fixture.orderId],
    });
    expect(await s.fulfillJobState(fixture.orderId)).toBe('waiting');
    const queuedAt = await notify.queuedAt(adminAction(auditId));
    expect(queuedAt).not.toBeNull();
    // The second tick: the job lives, nothing is added, the alert is the same job.
    expect((await step.run({ nowMs: now + 10 * MIN_MS })).counts).toEqual({ live: 1, replayed: 1 });
    expect((await t.fulfillQueue.getJob(fixture.orderId))?.id).toBe(fixture.orderId);
    expect(await notify.queuedAt(adminAction(auditId))).toBe(queuedAt);
    // CR m-2: the waiting job would be taken by a later e2e's fulfill consumer; not left behind.
    await (await t.fulfillQueue.getJob(fixture.orderId))?.remove();
  });

  it('ORDER_RETRY is not replayed into fulfillment past the abandon count or once the order moved', async () => {
    const { moduleRef } = await s.boot();
    const abandoned = await queuedOrder();
    await s.setAbandoned(abandoned.orderId, 3);
    const moved = await s.order(); // PAID: not QUEUED any more
    const audits: string[] = [];
    for (const orderId of [abandoned.orderId, moved.orderId]) {
      audits.push(
        await insertAudit(t.db, {
          action: 'ORDER_RETRY',
          targetType: 'Order',
          targetId: orderId,
          ageMs: 5 * MIN_MS,
        }),
      );
    }
    const { step } = auditEffectsStep(moduleRef, new Set([abandoned.orderId, moved.orderId]));
    const report = await step.run({ nowMs: await dbNowMs(t.db) });
    expect(report.counts).toEqual({ abandoned: 1, replayed: 2 });
    expect(await s.fulfillJobState(abandoned.orderId)).toBe('none');
    expect(await s.fulfillJobState(moved.orderId)).toBe('none');
    // CR-4: both alerts are there (and registered, so the run removes them: no orphan job).
    for (const auditId of audits)
      expect(await notify.queuedAt(adminAction(auditId))).not.toBeNull();
  });

  it('CR-5: 101 rows with one createdAt walk in two pages, none twice, none skipped', async () => {
    const { moduleRef } = await s.boot();
    const now = await dbNowMs(t.db);
    const createdAt = new Date(now - 10 * MIN_MS);
    const targetIds = Array.from({ length: RECONCILE_BATCH_LIMIT + 1 }, () => fakeTargetId('fx'));
    const created = await t.db.auditLog.createManyAndReturn({
      data: targetIds.map((targetId) => ({
        actorType: 'CLI',
        actorId: null,
        action: 'FX_SET',
        targetType: 'FxRate',
        targetId,
        before: {},
        after: {},
        reason: 'e2e: audit effects sweep',
        createdAt,
      })),
      select: { id: true },
    });
    const all = created.map((row) => row.id).sort();
    const { step, repository } = auditEffectsStep(moduleRef, new Set(targetIds));
    const pages: string[][] = [];
    const page = repository.page.bind(repository);
    jest.spyOn(repository, 'page').mockImplementation(async (...args) => {
      const rows = await page(...args);
      pages.push(rows.map((row) => row.id));
      return rows;
    });
    expect((await step.run({ nowMs: now })).counts).toEqual({ replayed: RECONCILE_BATCH_LIMIT });
    expect((await step.run({ nowMs: now })).counts).toEqual({ replayed: 1 });
    expect(pages.map((ids) => ids.length)).toEqual([RECONCILE_BATCH_LIMIT, 1]);
    expect(pages.flat().sort()).toEqual(all);
    for (const auditId of all) expect(await notify.queuedAt(adminAction(auditId))).not.toBeNull();
  });
});
