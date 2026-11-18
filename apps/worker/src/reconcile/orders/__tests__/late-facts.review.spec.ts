import { LATE_WATCH_WINDOW_MS } from '@repo/shared';
import { confirmedWatch } from '../late-facts.repository';
import { decideReview, evidenceKey } from '../review-evidence';
import { CONTEXT, attempt, confirmed, expiryPair, transfer } from './review-fixtures';

// Audit I-5 / D-64 (7): a transfer counted "not sent" first (EXPIRED, CONSUMED_UNMATCHED) and found
// on the chain later is never a TON_TX proof for the reconciler: a reconciler DELIVERED would close
// the order (and pay cashback and the referral bonus) on a fact that already lied once. Only the
// alert (`tonLateConfirmed`); the owner resolves the order.

const LATE_SCAN = {
  from: 'EXPIRED',
  outcome: 'CONFIRMED',
  via: 'SCAN',
  txHash: 'f'.repeat(64),
  txLt: '777',
  feeNanoTon: '1000',
};

describe('decideReview: a transfer found on the chain late (I-5)', () => {
  it('a late mark (scan or hint): ALERT_LATE, never DELIVER (mutant: the late skip removed)', () => {
    for (const late of [LATE_SCAN, { ...LATE_SCAN, from: 'CONSUMED_UNMATCHED', via: 'HINT' }]) {
      const t = confirmed();
      expect(decideReview([attempt(t, { ton: { late } })], CONTEXT)).toEqual({
        kind: 'ALERT_LATE',
        transferId: t.id,
      });
    }
  });

  it('without the mark too: a CONFIRMED transfer whose attempt holds an expiry pair or a CU fact', () => {
    const expired = confirmed();
    const viaPair = attempt(expired, { ton: { expiry: expiryPair(expired) } });
    expect(decideReview([viaPair], CONTEXT).kind).toBe('ALERT_LATE');
    const consumed = confirmed();
    const viaCu = attempt(consumed, { ton: { consumedUnmatched: { walletSeqno: 8 } } });
    expect(decideReview([viaCu], CONTEXT).kind).toBe('ALERT_LATE');
  });

  it('a first expiry observation alone (S5 MJ1) is no late fact: DELIVER stays', () => {
    const t = confirmed();
    const pair = expiryPair(t);
    const firstOnly = attempt(t, { ton: { expiry: { first: pair['first'] ?? null } } });
    expect(decideReview([firstOnly], CONTEXT).kind).toBe('DELIVER');
  });

  it('a late transfer next to a CONFIRMED one of a later attempt: still the owner’s', () => {
    const late = confirmed();
    const lateAttempt = attempt(late, { status: 'FAILED', ton: { late: LATE_SCAN } });
    const decision = decideReview([lateAttempt, attempt(confirmed())], CONTEXT);
    expect(decision).toEqual({ kind: 'ALERT_LATE', transferId: late.id });
  });

  it('an EXPIRED transfer of another attempt stays a plain refund proof (no late mark)', () => {
    const t = transfer();
    expect(decideReview([attempt(t)], CONTEXT).kind).toBe('REFUND');
  });

  it('evidenceKey changes when a late mark is written', () => {
    const t = confirmed();
    const before = attempt(t);
    const after = { ...attempt(t, { ton: { timeout: true, late: LATE_SCAN } }), id: before.id };
    expect(evidenceKey([after])).not.toBe(evidenceKey([before]));
  });
});

describe('decideReview: a CONFIRMED transfer whose value came back or was aborted (S9f F4, owner 2026-11-18)', () => {
  const facts = {
    lateDestination: {
      verdict: 'DESTINATION_ABORTED',
      destTxHash: 'e'.repeat(64),
      orderStatus: 'NEEDS_REVIEW',
    },
    lateBounce: {
      txHash: 'f'.repeat(64),
      returnTxHash: 'd'.repeat(64),
      orderStatus: 'NEEDS_REVIEW',
    },
  };

  it('SKIP SUSPECT, never DELIVER (mutant: the fact left out of hasSuspect)', () => {
    for (const [key, value] of Object.entries(facts)) {
      const t = confirmed();
      expect(decideReview([attempt(t, { ton: { [key]: value } })], CONTEXT)).toEqual({
        kind: 'SKIP',
        reason: 'SUSPECT',
      });
    }
    // Control: the same transfer without the fact is delivered.
    expect(decideReview([attempt(confirmed())], CONTEXT).kind).toBe('DELIVER');
  });

  it('evidenceKey changes when either fact is written', () => {
    for (const [key, value] of Object.entries(facts)) {
      const t = confirmed();
      const before = attempt(t, { ton: { timeout: true } });
      const after = { ...attempt(t, { ton: { timeout: true, [key]: value } }), id: before.id };
      expect(evidenceKey([after])).not.toBe(evidenceKey([before]));
    }
  });
});

describe('confirmedWatch (review F10)', () => {
  it('watches a CONFIRMED transfer from its creation OR its late confirmation', () => {
    const nowMs = Date.UTC(2026, 10, 18, 12, 0, 0);
    const since = new Date(nowMs - LATE_WATCH_WINDOW_MS);
    expect(confirmedWatch(nowMs)).toEqual({
      OR: [{ createdAt: { gt: since } }, { confirmedAt: { gt: since } }],
    });
  });
});
