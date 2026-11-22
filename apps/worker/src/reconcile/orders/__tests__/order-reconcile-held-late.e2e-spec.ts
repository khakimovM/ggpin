import { randomBytes } from 'node:crypto';
import type { Prisma } from '@repo/db';
import { ledgerOf, orderRow } from '../../../fulfillment/__tests__/fulfill-e2e.fixtures';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { episodeRef } from '../guard-ref';
import { HeldWriter } from '../held-writes';
import { RECONCILE_STEPS, type ReconcileStep } from '../reconcile-step';
import { TonLateService } from '../../../ton/ton-late.service';
import type { ReleasableReason } from '../held-release-policy';
import { useHeldE2e } from './held-sweep.e2e-kit';

// Phase 5 S9f, the HELD part of audit M-1 and L-1: a HELD order whose earlier payout the chain
// showed after all (a `late` / `lateDestination` fact), or one with a transfer that is not EXPIRED,
// is neither released (no run, so nothing is signed) nor refunded at HELD_MAX_AGE_MS; the owner
// hears `reconcileGuardRefused` once a day (owner 2026-11-18): beside a late fact
// `<orderId>_heldlate_<day>`, beside a live transfer `<orderId>_heldlive_<day>`. A fact committed after the
// decision is caught again inside the move's transaction (HeldPayoutError): nothing written. The
// rows of the earlier payout are made with the guards off (tests only): attempt 1 FAILED, its
// transfer on a throw-away wallet, as the TON module leaves them (a late CONFIRMED keeps the
// attempt FAILED).

const h = useHeldE2e();
const { t } = h;
const MAX_AGE = t.env.HELD_MAX_AGE_MS;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GUARD = 'reconcileGuardRefused' as const;
const hex64 = () => randomBytes(32).toString('hex');

const SEQNO_HELD: Prisma.InputJsonObject = {
  late: { from: 'EXPIRED', outcome: 'SEQNO_HELD', via: 'SCAN', txHash: hex64(), txLt: '7' },
};
const LATE_CONFIRMED: Prisma.InputJsonObject = {
  late: { from: 'EXPIRED', outcome: 'CONFIRMED', via: 'SCAN', txHash: hex64(), txLt: '9' },
};
const DESTINATION_ABORTED: Prisma.InputJsonObject = {
  lateDestination: { verdict: 'DESTINATION_ABORTED', destTxHash: null, orderStatus: 'HELD' },
};

async function heldOrder(reason: ReleasableReason | 'ADAPTER_ERROR') {
  const fixture = await h.order();
  await h.holdAs(fixture.orderId, reason);
  return { ...fixture, heldAt: await h.heldAtMs(fixture.orderId) };
}

/** Attempt 1 FAILED with its transfer in `status`, and `facts` in its `response.ton`. */
async function pastPayout(
  orderId: string,
  status: 'EXPIRED' | 'CONFIRMED',
  facts: Prisma.InputJsonObject | null,
): Promise<string> {
  let attemptId = '';
  await h.withTriggersOff(async (tx) => {
    const attempt = await tx.fulfillmentAttempt.create({
      data: {
        orderId,
        attemptNo: 1,
        adapter: 'FRAGMENT',
        status: 'FAILED',
        request: {},
        ...(facts === null ? {} : { response: { ton: facts } }),
      },
      select: { id: true },
    });
    attemptId = attempt.id;
    const chain =
      status === 'CONFIRMED' ? { txHash: hex64(), txLt: 9n, confirmedAt: new Date() } : {};
    await tx.tonTransfer.create({
      data: {
        purpose: 'ORDER',
        attemptId: attempt.id,
        network: 'testnet',
        walletAddress: `0:${hex64()}`,
        seqno: 1,
        validUntil: new Date(Date.now() - 3_600_000),
        toAddress: `0:${hex64()}`,
        amountNanoTon: 1_000_000n,
        payloadHash: hex64(),
        extMsgHash: hex64(),
        bocBase64: 'te6cckE=',
        status,
        ...chain,
      },
    });
  });
  return attemptId;
}

async function alerted(
  orderId: string,
  nowMs: number,
  scope: 'held' | 'heldlate' | 'heldlive' = 'heldlate',
): Promise<boolean> {
  const ref = episodeRef(orderId, scope, nowMs);
  return ref === null ? false : h.hasAlert('reconcileGuardRefused', ref);
}

/** A writer that commits a late fact on `attemptId` right after the decision, before its move. */
function factMidway(attemptId: () => string) {
  const addFact = () =>
    h.withTriggersOff((tx) =>
      tx.fulfillmentAttempt.update({
        where: { id: attemptId() },
        data: { response: { ton: SEQNO_HELD } },
      }),
    );
  return (prisma: PrismaService) =>
    new (class extends HeldWriter {
      override async refund(orderId: string, heldEvents: number) {
        await addFact();
        return super.refund(orderId, heldEvents);
      }
      override async release(orderId: string, reason: ReleasableReason, heldEvents: number) {
        await addFact();
        return super.release(orderId, reason, heldEvents);
      }
    })(prisma);
}

describe('S9f wiring', () => {
  it('runs the late facts after the S9e steps, with TonLateService of the TON module', async () => {
    const rc = await h.boot();
    const steps = rc.moduleRef.get<symbol, readonly ReconcileStep[]>(RECONCILE_STEPS);
    expect(steps.map((step) => step.name)).toEqual([
      'transfers',
      'review',
      'stale',
      'lockStuck',
      'noticeResend',
      'held',
      'walletBlocked',
      'late',
      // S9h: the audit effects come last (D-64 (1) order).
      'auditEffects',
    ]);
    expect(rc.moduleRef.get(TonLateService)).toBeInstanceOf(TonLateService);
  });
});

describe('S9f: a HELD order beside a payout that may have gone out', () => {
  it('L-1: at HELD_MAX_AGE_MS a late fact keeps it (no refund, the owner hears); a clean one is refunded', async () => {
    const rc = await h.boot();
    const late = await heldOrder('ADAPTER_ERROR');
    await pastPayout(late.orderId, 'EXPIRED', SEQNO_HELD);
    const clean = await heldOrder('ADAPTER_ERROR');
    await pastPayout(clean.orderId, 'EXPIRED', null);
    const nowMs = Math.max(late.heldAt, clean.heldAt) + MAX_AGE;

    const report = await rc.held.run({ nowMs });
    expect(report.counts).toMatchObject({ payoutRefused: 1, 'payout:lateFact': 1, refunded: 1 });
    expect((await orderRow(t.db, late.orderId)).status).toBe('HELD');
    expect((await ledgerOf(t.db, late.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    expect(await h.hasAlert('heldExpiredRefunded', late.orderId)).toBe(false);
    expect(await alerted(late.orderId, nowMs)).toBe(true);
    expect((await orderRow(t.db, clean.orderId)).status).toBe('REFUNDED');
    expect(await alerted(clean.orderId, nowMs)).toBe(false);
    expect(await alerted(late.orderId, nowMs, 'held')).toBe(false);
    // The next tick: still kept, still no refund.
    const again = await rc.held.run({ nowMs: nowMs + MINUTE });
    expect(again.counts).toMatchObject({ payoutRefused: 1 });
    expect((await ledgerOf(t.db, late.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
  });

  it.each([
    ['a late fact', 'lateFact', 'EXPIRED', SEQNO_HELD, 'heldlate'],
    ['a live transfer', 'liveTransfer', 'CONFIRMED', null, 'heldlive'],
  ] as const)(
    'owner 2026-11-18: beside %s the owner hears once a day, not every hour',
    async (_label, why, status, facts, scope) => {
      const rc = await h.boot();
      const late = await heldOrder('ADAPTER_ERROR');
      await pastPayout(late.orderId, status, facts);
      const dayStart = Math.ceil((late.heldAt + MAX_AGE) / DAY) * DAY;
      const tick = async (nowMs: number) => {
        expect((await rc.held.run({ nowMs })).counts).toMatchObject({ [`payout:${why}`]: 1 });
        expect(await alerted(late.orderId, nowMs, 'held')).toBe(false);
        expect(await alerted(late.orderId, nowMs, scope)).toBe(true);
        const refId = episodeRef(late.orderId, scope, nowMs) ?? 'none';
        return { refId, at: await t.jobQueuedAt({ kind: 'OWNER_ALERT', alert: GUARD, refId }) };
      };
      const first = await tick(dayStart + HOUR);
      // Four hours later on the same day: the same id, the job queued once (deduped).
      expect(await tick(dayStart + 5 * HOUR)).toEqual(first);
      // The next day: a new reminder.
      expect((await tick(dayStart + DAY + HOUR)).refId).not.toBe(first.refId);
      expect((await orderRow(t.db, late.orderId)).status).toBe('HELD');
      expect((await ledgerOf(t.db, late.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    },
  );

  it('M-1: late CONFIRMED, lateDestination or a live transfer: never released, nothing signed', async () => {
    const rc = await h.boot();
    const confirmed = await heldOrder('NO_ADAPTER');
    await pastPayout(confirmed.orderId, 'CONFIRMED', LATE_CONFIRMED);
    const aborted = await heldOrder('NO_ADAPTER');
    await pastPayout(aborted.orderId, 'CONFIRMED', DESTINATION_ABORTED);
    const live = await heldOrder('NO_ADAPTER');
    await pastPayout(live.orderId, 'CONFIRMED', null);
    const clean = await heldOrder('NO_ADAPTER');
    await pastPayout(clean.orderId, 'EXPIRED', null);
    const kept = [
      { ...confirmed, scope: 'heldlate' as const },
      { ...aborted, scope: 'heldlate' as const },
      { ...live, scope: 'heldlive' as const },
    ];
    const nowMs = Math.max(...[...kept, clean].map((o) => o.heldAt)) + MINUTE;

    const report = await rc.held.run({ nowMs });
    expect(report.counts).toMatchObject({
      payoutRefused: 3,
      'payout:lateFact': 2,
      'payout:liveTransfer': 1,
      released: 1,
    });
    for (const order of kept) {
      expect((await orderRow(t.db, order.orderId)).status).toBe('HELD');
      expect(await h.releasesOf(order.orderId)).toBe(0);
      expect(await h.fulfillJobState(order.orderId)).toBe('none');
      expect(await alerted(order.orderId, nowMs, order.scope)).toBe(true);
    }
    expect((await orderRow(t.db, clean.orderId)).status).toBe('QUEUED');
    expect(t.executedOnChain()).toBe(0);
  });

  it('a fact committed after the decision: the move rolls back (refund and release alike)', async () => {
    let attemptId = '';
    const rc = await h.boot({ writer: factMidway(() => attemptId) });
    const refund = await heldOrder('ADAPTER_ERROR');
    attemptId = await pastPayout(refund.orderId, 'EXPIRED', null);
    const atAge = refund.heldAt + MAX_AGE;
    expect((await rc.held.run({ nowMs: atAge })).counts).toMatchObject({
      payoutRefused: 1,
      'payout:lateFact': 1,
    });
    expect((await orderRow(t.db, refund.orderId)).status).toBe('HELD');
    expect((await ledgerOf(t.db, refund.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    expect(await t.db.orderEvent.count({ where: { orderId: refund.orderId, to: 'FAILED' } })).toBe(
      0,
    );
    expect(await alerted(refund.orderId, atAge)).toBe(true);

    const release = await heldOrder('NO_ADAPTER');
    attemptId = await pastPayout(release.orderId, 'EXPIRED', null);
    const young = release.heldAt + MINUTE;
    // The first order is kept again by the decision (its fact is now on the row), this one by the
    // release transaction.
    const report = await rc.held.run({ nowMs: young });
    expect(report.counts).toMatchObject({ payoutRefused: 2, 'payout:lateFact': 2 });
    expect(report.ids).toEqual(expect.arrayContaining([refund.orderId, release.orderId]));
    expect((await orderRow(t.db, release.orderId)).status).toBe('HELD');
    expect(await h.releasesOf(release.orderId)).toBe(0);
    expect(await h.fulfillJobState(release.orderId)).toBe('none');
  });
});
