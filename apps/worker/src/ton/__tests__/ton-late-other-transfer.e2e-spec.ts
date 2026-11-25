import { randomBytes } from 'node:crypto';
import { ReviewProofError, resolveNeedsReview } from '@repo/db';
import { HINT_TRANSIENT_LOOKS } from '../ton-late-hint';
import type { TonNotice } from '../ton-notices';
import { earlierLivePayout } from '../ton-sign-guards';
import { rowsOf, tonFactOf } from './ton-e2e.fixtures';
import { useTonE2e } from './ton-e2e.harness';
import { lateServiceOf, ledgerOf, liveHoldsSeqno } from './ton-late.e2e-kit';

// S9f CR M2 on the real database: the owner's Z6 hint for the CONSUMED_UNMATCHED transfer T2 names
// a transaction that carries the message of T1 (EXPIRED, never looked at by the 72 h late scan):
// OTHER_TRANSFER. T1's message reached the chain, so T1 gets its own `late` fact (OTHER_TRANSFER,
// via HINT) and every guard that reads late facts counts it as paid: the owner's
// TON_UNMATCHED_RESOLVED for T2 is LIVE_PAYOUT (nothing written), and the M-1 sign gate names T1.
// Control: a hint REJECTED for any other reason marks nothing, and the same owner proof passes.

const t = useTonE2e();

const OWNER_CLI = {
  kind: 'operator',
  type: 'CLI',
  id: 'owner-e2e',
  ip: null,
  osUser: 'e2e',
  otpVerified: true,
} as const;

/** The owner alert of an OTHER_TRANSFER mark on a settled order (S9i N-1): <T1>_<auditId>. */
function otherLateAlert(transferId: string, auditId: string): TonNotice {
  return { kind: 'ALERT', alert: 'tonLateConfirmed', refId: `${transferId}_${auditId}` };
}

function unmatchedProof(transferId: string) {
  return {
    kind: 'TON_UNMATCHED_RESOLVED',
    transferId,
    finding: 'NOT_SENT',
    consumingTxHash: randomBytes(32).toString('hex'),
    reason: 'the owner read the chain: the seqno was used, nothing was paid by it',
  } as const;
}

function resolveUnmatched(orderId: string, transferId: string) {
  return t.db.$transaction((tx) =>
    resolveNeedsReview(tx, {
      orderId,
      to: 'FAILED',
      proof: unmatchedProof(transferId),
      resolver: OWNER_CLI,
    }),
  );
}

/** Every customer has a wallet row (the refund locks it first); the TON fixture has none. */
async function withWallet(userId: string): Promise<void> {
  await t.db.wallet.create({ data: { userId } });
}

async function reviewAudits(orderId: string): Promise<number> {
  return t.db.auditLog.count({ where: { targetId: orderId, action: 'ORDER_REVIEW_RESOLVE' } });
}

describe('TON late facts: OTHER_TRANSFER marks the other transfer paid (S9f CR M2)', () => {
  it('the hint marks T1 late; the owner proof for T2 is LIVE_PAYOUT; the sign gate names T1', async () => {
    const { fixture, next, firstId, liveId, landed } = await liveHoldsSeqno(t);
    // Past the late scan's window: nothing on T1 says its message landed.
    expect(tonFactOf((await rowsOf(t.db, fixture)).attempt.response, 'late')).toBeNull();
    expect(await earlierLivePayout(t.db, fixture.orderId, next.attemptId)).toBeNull();
    const late = lateServiceOf(t.ton.moduleRef, t.gateway, [t.gateway.freshConnection()]);
    const hint = { auditId: 'cmh1auditotherm200000001', ...landed };
    expect(await late.checkHint(liveId, hint)).toEqual({ kind: 'WRITTEN', what: 'HINT_REJECTED' });

    const first = await rowsOf(t.db, fixture);
    expect(first.transfer?.status).toBe('EXPIRED');
    expect(tonFactOf(first.attempt.response, 'late')).toEqual({
      from: 'EXPIRED',
      outcome: 'OTHER_TRANSFER',
      via: 'HINT',
      auditId: hint.auditId,
      hintedTransferId: liveId,
      txHash: landed.txHash,
      txLt: landed.lt,
    });
    const live = await rowsOf(t.db, next);
    expect(tonFactOf(live.attempt.response, 'hint')).toEqual({
      auditId: hint.auditId,
      verdict: 'REJECTED',
      code: 'OTHER_TRANSFER',
      message: `OTHER_TRANSFER(${firstId})`,
    });
    // The M-1 sign gate: T1 may have gone out (a second payout is never signed beside it).
    expect(await earlierLivePayout(t.db, fixture.orderId, next.attemptId)).toBe(firstId);
    // The order is still in review (its guards stop on the mark): no extra owner alert (S9i N-1).
    await t.expectNoJob(otherLateAlert(firstId, hint.auditId));

    // (a) The owner's proof bound to T2 settles T2 only: T1's late fact stops it, nothing written.
    await withWallet(fixture.userId);
    const ledger = await ledgerOf(t.db, fixture.userId);
    const error: unknown = await resolveUnmatched(fixture.orderId, liveId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewProofError);
    expect(error).toMatchObject({ problem: 'LIVE_PAYOUT' });
    const after = await rowsOf(t.db, next);
    expect(after.order.status).toBe('NEEDS_REVIEW');
    expect(after.attempt.status).toBe('UNKNOWN');
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(ledger);
    expect(await reviewAudits(fixture.orderId)).toBe(0);

    // A replay of the same hint writes nothing a second time (the fact is kept as it is).
    const again = lateServiceOf(t.ton.moduleRef, t.gateway, [t.gateway.freshConnection()]);
    expect(await again.checkHint(liveId, hint)).toEqual({ kind: 'NOTHING', why: 'ALREADY' });
    expect(t.gateway.sentBocs).toHaveLength(2);
  });

  it('S9i N-1: on a REFUNDED order the mark is the owner’s tonLateConfirmed <T1>_<auditId>, once', async () => {
    const { fixture, firstId, liveId, landed } = await liveHoldsSeqno(t);
    // The owner settled the order first (T2 proven not sent): REFUNDED, no guard watches it any more.
    await withWallet(fixture.userId);
    expect((await resolveUnmatched(fixture.orderId, liveId)).refund?.outcome).toBe('REFUNDED');
    const refunded = await ledgerOf(t.db, fixture.userId);
    const late = lateServiceOf(t.ton.moduleRef, t.gateway, [t.gateway.freshConnection()]);
    const hint = { auditId: 'cmh1auditotherrefund0001', ...landed };
    expect(await late.checkHint(liveId, hint)).toEqual({ kind: 'WRITTEN', what: 'HINT_REJECTED' });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.order.status).toBe('REFUNDED');
    expect(tonFactOf(rows.attempt.response, 'late')).toMatchObject({
      outcome: 'OTHER_TRANSFER',
      auditId: hint.auditId,
    });
    const notice = otherLateAlert(firstId, hint.auditId);
    await t.expectJobs([notice]);
    // Money untouched; the transfer's own late alert keeps its plain id (not sent here).
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(refunded);
    await t.expectNoJob({ kind: 'ALERT', alert: 'tonLateConfirmed', refId: firstId });
    // The TON module sends it with the write only: a replay writes nothing and queues nothing (the
    // re-queue from the kept facts is the reconciler's, late-facts.e2e-spec.ts, review R1).
    await t.dropJobs([notice]);
    expect(await late.checkHint(liveId, hint)).toEqual({ kind: 'NOTHING', why: 'ALREADY' });
    await t.expectNoJob(notice);
  });

  it('(d) control: a hint REJECTED for another reason marks nothing; the owner proof for T2 passes', async () => {
    const { fixture, next, liveId, landed } = await liveHoldsSeqno(t);
    const late = lateServiceOf(t.ton.moduleRef, t.gateway, [t.gateway.freshConnection()]);
    const wrongLt = {
      auditId: 'audit-other-control',
      txHash: landed.txHash,
      lt: String(BigInt(landed.lt) + 1n),
    };
    for (let look = 1; look < HINT_TRANSIENT_LOOKS; look += 1) {
      expect(await late.checkHint(liveId, wrongLt)).toEqual({ kind: 'WAIT', why: 'TX_NOT_FOUND' });
    }
    expect(await late.checkHint(liveId, wrongLt)).toEqual({
      kind: 'WRITTEN',
      what: 'HINT_REJECTED',
    });
    expect(tonFactOf((await rowsOf(t.db, next)).attempt.response, 'hint')).toMatchObject({
      code: 'TX_NOT_FOUND',
    });
    expect(tonFactOf((await rowsOf(t.db, fixture)).attempt.response, 'late')).toBeNull();
    await withWallet(fixture.userId);
    const result = await resolveUnmatched(fixture.orderId, liveId);
    expect(result.refund?.outcome).toBe('REFUNDED');
    expect((await rowsOf(t.db, fixture)).order.status).toBe('REFUNDED');
  });
});
