import { NeedsReviewProofSchema, RECONCILER_PROOF_REASON } from '@repo/shared';
import { consumedTransferIds, decideReview, evidenceKey } from '../review-evidence';
import {
  CHECKED_AT,
  CONTEXT,
  VALID_UNTIL,
  WALLET,
  attempt,
  confirmed,
  expiryPair,
  transfer,
} from './review-fixtures';

// D-64 (2), plan §4.4: the reconciler proves only TON_TX (one CONFIRMED transfer, its attempt the
// only unresolved one) and TON_NOT_SENT (EVERY transfer EXPIRED on two bound observations, no
// witness conflict ever); everything else is the owner's, CONSUMED_UNMATCHED only an alert.

describe('decideReview', () => {
  describe('TON_TX -> DELIVERED', () => {
    it('proves the one CONFIRMED transfer of the only unresolved attempt', () => {
      const t = confirmed();
      const decision = decideReview([attempt(t)], CONTEXT);
      expect(decision).toEqual({
        kind: 'DELIVER',
        transferId: t.id,
        proof: {
          kind: 'TON_TX',
          extMsgHash: t.extMsgHash,
          walletAddress: WALLET,
          txHash: t.txHash,
          lt: '777',
          reason: RECONCILER_PROOF_REASON,
        },
      });
      // The proof passes the shared schema the helper validates with.
      if (decision.kind !== 'DELIVER') throw new Error('expected DELIVER');
      expect(NeedsReviewProofSchema.safeParse(decision.proof).success).toBe(true);
    });

    it('also when an earlier transfer of the order provably expired', () => {
      const old = attempt(transfer(), { status: 'FAILED' });
      expect(decideReview([old, attempt(confirmed())], CONTEXT).kind).toBe('DELIVER');
    });

    it('not when another attempt is unresolved too, or the transfer has no transaction', () => {
      const other = attempt(transfer({ status: 'EXPIRED' }));
      expect(decideReview([other, attempt(confirmed())], CONTEXT)).toEqual({
        kind: 'SKIP',
        reason: 'NOT_PROVABLE',
      });
      expect(decideReview([attempt(confirmed({ txLt: null }))], CONTEXT).kind).toBe('SKIP');
      expect(decideReview([attempt(confirmed(), { status: 'FAILED' })], CONTEXT).kind).toBe('SKIP');
    });

    it('not with two CONFIRMED transfers, or next to a BOUNCED one', () => {
      expect(decideReview([attempt(confirmed()), attempt(confirmed())], CONTEXT).kind).toBe('SKIP');
      const bounced = attempt(transfer({ status: 'BOUNCED' }), { status: 'FAILED' });
      expect(decideReview([bounced, attempt(confirmed())], CONTEXT).kind).toBe('SKIP');
    });
  });

  describe('TON_NOT_SENT -> FAILED + REFUND', () => {
    it('proves an EXPIRED transfer from its second observation', () => {
      const t = transfer();
      const decision = decideReview([attempt(t)], CONTEXT);
      expect(decision).toEqual({
        kind: 'REFUND',
        transferId: t.id,
        proof: {
          kind: 'TON_NOT_SENT',
          extMsgHash: t.extMsgHash,
          walletAddress: WALLET,
          seqno: 7,
          validUntil: VALID_UNTIL.toISOString(),
          checkedSeqno: 7,
          checkedAt: CHECKED_AT,
          reason: RECONCILER_PROOF_REASON,
        },
      });
      if (decision.kind !== 'REFUND') throw new Error('expected REFUND');
      expect(NeedsReviewProofSchema.safeParse(decision.proof).success).toBe(true);
    });

    it('names the transfer of the one unresolved attempt among several expired ones', () => {
      const failed = attempt(transfer({ seqno: 6 }), { status: 'FAILED' });
      const own = transfer({ seqno: 7 });
      const decision = decideReview([failed, attempt(own)], CONTEXT);
      expect(decision).toMatchObject({ kind: 'REFUND', transferId: own.id });
    });

    it('needs EVERY transfer expired (mutant: "any EXPIRED")', () => {
      for (const status of ['SIGNED', 'BROADCAST', 'BOUNCED', 'ONCHAIN_FAILED'] as const) {
        // Even with a well-bound pair of observations on it (stale or forged facts), a transfer
        // that is not EXPIRED is no proof: only the status check stands between it and a refund.
        const t = transfer({ status });
        const other = attempt(t, { status: 'FAILED', ton: { expiry: expiryPair(t) } });
        expect(decideReview([other, attempt(transfer())], CONTEXT)).toEqual({
          kind: 'SKIP',
          reason: 'NOT_PROVABLE',
        });
      }
    });

    it('needs both observations, bound to the very transfer and message', () => {
      const t = transfer();
      const pair = expiryPair(t);
      const onlyFirst = attempt(t, { ton: { expiry: { first: pair['first'] ?? null } } });
      expect(decideReview([onlyFirst], CONTEXT).kind).toBe('SKIP');
      const other = transfer();
      const foreignPair = attempt(t, { ton: { expiry: expiryPair(other) } });
      expect(decideReview([foreignPair], CONTEXT).kind).toBe('SKIP');
      const tooClose = attempt(t, { ton: { expiry: expiryPair(t, 1) } });
      expect(decideReview([tooClose], CONTEXT).kind).toBe('SKIP');
      const noFacts = attempt(t, { ton: { timeout: true } });
      expect(decideReview([noFacts], CONTEXT).kind).toBe('SKIP');
    });

    it('needs the observations of EVERY expired transfer, not only the chosen one', () => {
      const failed = attempt(transfer({ seqno: 6 }), { status: 'FAILED', ton: { timeout: true } });
      expect(decideReview([failed, attempt(transfer())], CONTEXT).kind).toBe('SKIP');
    });

    it('not with two unresolved attempts', () => {
      expect(decideReview([attempt(transfer()), attempt(transfer())], CONTEXT)).toEqual({
        kind: 'SKIP',
        reason: 'NOT_PROVABLE',
      });
    });
  });

  describe('the owner keeps', () => {
    it('a witness conflict ever recorded, even next to an expiry pair (mutant: check removed)', () => {
      const t = transfer();
      const conflicted = attempt(t, {
        ton: { expiry: expiryPair(t), witnessConflict: { detail: 'SEQNO_MOVED', witness: 1 } },
      });
      expect(decideReview([conflicted], CONTEXT)).toEqual({
        kind: 'SKIP',
        reason: 'WITNESS_CONFLICT',
      });
      const sibling = attempt(transfer({ seqno: 6 }), {
        status: 'FAILED',
        ton: { witnessConflict: { detail: 'SEQNO_MOVED', witness: 1 } },
      });
      expect(decideReview([sibling, attempt(transfer())], CONTEXT).kind).toBe('SKIP');
    });

    it('a suspect transaction ever recorded', () => {
      const t = confirmed();
      const suspect = attempt(t, { ton: { suspect: { detail: 'DESTINATION_ABORTED' } } });
      expect(decideReview([suspect], CONTEXT)).toEqual({ kind: 'SKIP', reason: 'SUSPECT' });
    });

    it('a transfer of another wallet, network or purpose', () => {
      for (const overrides of [
        { walletAddress: `0:${'b'.repeat(64)}` },
        { network: 'mainnet' },
        { purpose: 'SELFTEST' },
      ]) {
        expect(decideReview([attempt(confirmed(overrides))], CONTEXT)).toEqual({
          kind: 'SKIP',
          reason: 'FOREIGN_TRANSFER',
        });
      }
    });

    it('an unresolved attempt without a transfer (a supplier, or SENDING never signed: Q-18)', () => {
      expect(decideReview([attempt(null, { status: 'SENDING' })], CONTEXT).kind).toBe('SKIP');
      const supplier = attempt(null, { status: 'UNKNOWN' });
      expect(decideReview([attempt(confirmed()), supplier], CONTEXT)).toEqual({
        kind: 'SKIP',
        reason: 'TRANSFERLESS_ATTEMPT',
      });
    });

    it('an unresolved, BOUNCED or ONCHAIN_FAILED transfer', () => {
      for (const status of ['SIGNED', 'BROADCAST', 'BOUNCED', 'ONCHAIN_FAILED'] as const) {
        expect(decideReview([attempt(transfer({ status }))], CONTEXT).kind).toBe('SKIP');
      }
    });

    it('CONSUMED_UNMATCHED: only the alert, about that transfer', () => {
      const t = transfer({ status: 'CONSUMED_UNMATCHED' });
      expect(decideReview([attempt(t)], CONTEXT)).toEqual({
        kind: 'ALERT_CONSUMED',
        transferId: t.id,
      });
    });
  });

  describe('evidenceKey', () => {
    it('ignores attempt statuses (the resolution closes them) but not facts or transfers', () => {
      const t = transfer();
      const before = attempt(t);
      const key = evidenceKey([before]);
      expect(evidenceKey([{ ...before, status: 'FAILED' }])).toBe(key);
      expect(evidenceKey([{ ...before, transfer: { ...t, status: 'CONFIRMED' } }])).not.toBe(key);
      const conflicted = attempt(t, {
        ton: { expiry: expiryPair(t), witnessConflict: { detail: 'SEQNO_MOVED', witness: 1 } },
      });
      expect(evidenceKey([{ ...conflicted, id: before.id }])).not.toBe(key);
    });
  });

  describe('consumedTransferIds (audit I-2): the owner hears of a CU transfer whatever the decision', () => {
    it('lists it next to a witness conflict, a suspect transaction or an attempt without a transfer', () => {
      const cu = transfer({ status: 'CONSUMED_UNMATCHED' });
      const cases = [
        {
          reason: 'WITNESS_CONFLICT',
          attempts: [attempt(cu, { ton: { witnessConflict: { at: 1 } } })],
        },
        { reason: 'SUSPECT', attempts: [attempt(cu, { ton: { suspect: { at: 1 } } })] },
        {
          reason: 'TRANSFERLESS_ATTEMPT',
          attempts: [attempt(cu, { status: 'FAILED' }), attempt(null)],
        },
      ] as const;
      for (const { reason, attempts } of cases) {
        expect(decideReview(attempts, CONTEXT)).toEqual({ kind: 'SKIP', reason });
        expect(consumedTransferIds(attempts)).toEqual([cu.id]);
      }
    });

    it('lists every CU transfer and nothing else', () => {
      const [a, b] = [
        transfer({ status: 'CONSUMED_UNMATCHED' }),
        transfer({ status: 'CONSUMED_UNMATCHED' }),
      ];
      const attempts = [
        attempt(a, { status: 'FAILED' }),
        attempt(transfer()),
        attempt(b),
        attempt(null),
      ];
      expect(consumedTransferIds(attempts)).toEqual([a.id, b.id]);
      expect(consumedTransferIds([attempt(transfer()), attempt(confirmed())])).toEqual([]);
    });
  });
});
