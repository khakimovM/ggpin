import { resolveNeedsReview } from '@repo/db';
import { notifyJobId } from '@repo/shared';
import { randomBytes } from 'node:crypto';
import { rowsOf, tonFactOf } from '../../../ton/__tests__/ton-e2e.fixtures';
import { useTonE2e } from '../../../ton/__tests__/ton-e2e.harness';
import { consumedByTwin, ledgerOf, liveHoldsSeqno } from '../../../ton/__tests__/ton-late.e2e-kit';
import { foreignRef } from '../../../ton/ton-late-hint';
import { noticeJob, type TonNotice } from '../../../ton/ton-notices';
import { HINT_REPEAT_MAX_AGE_MS } from '../late-hint-repeats';
import { failFirstAdd, lateStepOf, ownerHintRow } from './late-facts.e2e-kit';

// S9i on the real database: two decided hints whose owner alert the late-facts step queues again on
// every lap, from the kept facts, so an enqueue lost right after the decision is made good (S9f SA
// N-2: FOREIGN_MESSAGE; review R1: an OTHER_TRANSFER mark of a settled order); and only while the
// decided hint's audit row is inside the notify dedupe window on the database clock (review R2).

const t = useTonE2e();

/** A tick this long after now: the decided hint's audit row is past the repeat window (M2). */
const PAST_WINDOW_MS = HINT_REPEAT_MAX_AGE_MS + 60_000;
/** A tick a day before the window's edge: still queued again (M1). */
const NEAR_EDGE_MS = HINT_REPEAT_MAX_AGE_MS - 86_400_000;

/** The owner alert of an OTHER_TRANSFER mark of T1 by the hint `auditId` (S9i N-1, R1). */
function otherLate(transferId: string, auditId: string): TonNotice {
  return { kind: 'ALERT', alert: 'tonLateConfirmed', refId: `${transferId}_${auditId}` };
}

const jobIdOf = (notice: TonNotice): string => notifyJobId(noticeJob(notice));

const OWNER_CLI = {
  kind: 'operator',
  type: 'CLI',
  id: 'owner-e2e',
  ip: null,
  osUser: 'e2e',
  otpVerified: true,
} as const;

/** The owner proves T2 never paid (TON_UNMATCHED_RESOLVED): the order is refunded. */
async function refundThroughOwner(orderId: string, userId: string, transferId: string) {
  await t.db.wallet.create({ data: { userId } });
  return t.db.$transaction((tx) =>
    resolveNeedsReview(tx, {
      orderId,
      to: 'FAILED',
      proof: {
        kind: 'TON_UNMATCHED_RESOLVED',
        transferId,
        finding: 'NOT_SENT',
        consumingTxHash: randomBytes(32).toString('hex'),
        reason: 'the owner read the chain: the seqno was used, nothing was paid by it',
      },
      resolver: OWNER_CLI,
    }),
  );
}

describe('LateFactsStep: alerts queued again from decided hints (S9i)', () => {
  it('N-2 + R2: FOREIGN_MESSAGE, first add failed: re-queued every lap, never past the dedupe window', async () => {
    const { transferId, ref } = await consumedByTwin(t);
    const foreign: TonNotice = {
      kind: 'ALERT',
      alert: 'tonSeqnoUnmatched',
      refId: foreignRef(transferId),
    };
    const failer = failFirstAdd(t, notifyJobId(noticeJob(foreign)));
    try {
      const step = lateStepOf(t, [t.gateway.freshConnection()]);
      await ownerHintRow(t, transferId, ref, 'CLI');
      expect((await step.run({ nowMs: Date.now() })).counts).toMatchObject({ HINT_REJECTED: 1 });
      expect(failer.adds()).toBe(1);
      await t.expectNoJob(foreign);
      // The verdict is kept: the next tick decides nothing again but queues the alert from it.
      const again = await step.run({ nowMs: Date.now() });
      expect(again.counts['HINT_REJECTED']).toBeUndefined();
      expect(failer.adds()).toBe(2);
      await t.expectJobs([foreign]);
      // Every lap adds it again (one job kept by BullMQ).
      await step.run({ nowMs: Date.now() });
      expect(failer.adds()).toBe(3);
      // M1: a day before the window's edge it is still queued again.
      await step.run({ nowMs: Date.now() + NEAR_EDGE_MS });
      expect(failer.adds()).toBe(4);
      // R2 / M2: past the window (dedupe less a day) nothing is queued again, even with the job gone.
      await t.dropJobs([foreign]);
      await step.run({ nowMs: Date.now() + PAST_WINDOW_MS });
      expect(failer.adds()).toBe(4);
      await t.expectNoJob(foreign);
    } finally {
      failer.restore();
    }
  });

  it('R1 + R2: OTHER_TRANSFER on a REFUNDED order, first add failed: the next tick queues <T1>_<auditId>', async () => {
    const { fixture, firstId, liveId, landed } = await liveHoldsSeqno(t);
    expect(
      (await refundThroughOwner(fixture.orderId, fixture.userId, liveId)).refund?.outcome,
    ).toBe('REFUNDED');
    const refunded = await ledgerOf(t.db, fixture.userId);
    const audit = await ownerHintRow(t, liveId, landed, 'CLI');
    const notice = otherLate(firstId, audit.id);
    const failer = failFirstAdd(t, notifyJobId(noticeJob(notice)));
    try {
      const step = lateStepOf(t, [t.gateway.freshConnection()]);
      expect((await step.run({ nowMs: Date.now() })).counts).toMatchObject({ HINT_REJECTED: 1 });
      const rows = await rowsOf(t.db, fixture);
      expect(rows.order.status).toBe('REFUNDED');
      expect(tonFactOf(rows.attempt.response, 'late')).toMatchObject({
        outcome: 'OTHER_TRANSFER',
        auditId: audit.id,
        hintedTransferId: liveId,
      });
      expect(failer.adds()).toBe(1);
      await t.expectNoJob(notice);
      // Made good from the kept facts by the next tick, and again every lap (one job kept).
      await step.run({ nowMs: Date.now() });
      expect(failer.adds()).toBe(2);
      await t.expectJobs([notice]);
      await step.run({ nowMs: Date.now() });
      expect(failer.adds()).toBe(3);
      // R2 / M2: past the window (dedupe less a day) nothing is queued again, even with the job gone.
      await t.dropJobs([notice]);
      await step.run({ nowMs: Date.now() + PAST_WINDOW_MS });
      expect(failer.adds()).toBe(3);
      await t.expectNoJob(notice);
      expect(await ledgerOf(t.db, fixture.userId)).toEqual(refunded);
    } finally {
      failer.restore();
    }
  });

  it('M5 (1): an OTHER_TRANSFER mark while the order is still in review: no alert, no add', async () => {
    const { fixture, firstId, liveId, landed } = await liveHoldsSeqno(t);
    const audit = await ownerHintRow(t, liveId, landed, 'CLI');
    const notice = otherLate(firstId, audit.id);
    const counter = failFirstAdd(t, jobIdOf(notice), false);
    try {
      const step = lateStepOf(t, [t.gateway.freshConnection()]);
      expect((await step.run({ nowMs: Date.now() })).counts).toMatchObject({ HINT_REJECTED: 1 });
      await step.run({ nowMs: Date.now() });
      const rows = await rowsOf(t.db, fixture);
      expect(rows.order.status).toBe('NEEDS_REVIEW');
      expect(tonFactOf(rows.attempt.response, 'late')).toMatchObject({ auditId: audit.id });
      expect(counter.adds()).toBe(0);
      await t.expectNoJob(notice);
    } finally {
      counter.restore();
    }
  });

  it('M5 (2) / M6: a newer hint on T2 is not the hint that marked T1: no alert for it', async () => {
    const { fixture, firstId, liveId, landed } = await liveHoldsSeqno(t);
    await refundThroughOwner(fixture.orderId, fixture.userId, liveId);
    const step = lateStepOf(t, [t.gateway.freshConnection()]);
    const first = await ownerHintRow(t, liveId, landed, 'CLI');
    expect((await step.run({ nowMs: Date.now() })).counts).toMatchObject({ HINT_REJECTED: 1 });
    await t.expectJobs([otherLate(firstId, first.id)]);
    // The owner names the same transaction again: T2's kept verdict is the new hint, T1 keeps the
    // mark of the first one (written once), so the new hint's alert would name a mark it never wrote.
    const second = await ownerHintRow(t, liveId, landed, 'CLI');
    const notice = otherLate(firstId, second.id);
    const counter = failFirstAdd(t, jobIdOf(notice), false);
    try {
      expect((await step.run({ nowMs: Date.now() })).counts).toMatchObject({ HINT_REJECTED: 1 });
      await step.run({ nowMs: Date.now() });
      expect(tonFactOf((await rowsOf(t.db, fixture)).attempt.response, 'late')).toMatchObject({
        auditId: first.id,
      });
      expect(counter.adds()).toBe(0);
      await t.expectNoJob(notice);
    } finally {
      counter.restore();
    }
  });
});
