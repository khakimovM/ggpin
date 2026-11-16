import { describe, expect, it } from 'vitest';
import { LIST_MAX_LIMIT } from '../common-schemas';
import { NeedsReviewProofSchema } from './review-proof';
import {
  AUDIT_EFFECTS_MIN_AGE_MS,
  AUDIT_EFFECTS_WINDOW_MS,
  HELD_AUTO_RELEASE_MAX,
  LATE_WATCH_WINDOW_MS,
  ORDER_LOCK_STUCK_AFTER_MS,
  ORDER_STALE_AFTER_MS,
  RECONCILE_BATCH_LIMIT,
  RECONCILER_PROOF_REASON,
  REVIEW_NOTICE_RESEND_WINDOW_MS,
} from './reconcile-config';

const MIN = 60_000;
const HOUR = 60 * MIN;
const HASH = 'a'.repeat(64);

describe('order reconciler constants (D-64 (10))', () => {
  it('hold the owner-approved values', () => {
    expect(ORDER_STALE_AFTER_MS).toBe(10 * MIN);
    expect(HELD_AUTO_RELEASE_MAX).toBe(3);
    expect(REVIEW_NOTICE_RESEND_WINDOW_MS).toBe(24 * HOUR);
    expect(AUDIT_EFFECTS_WINDOW_MS).toBe(24 * HOUR);
    expect(AUDIT_EFFECTS_MIN_AGE_MS).toBe(2 * MIN);
    expect(LATE_WATCH_WINDOW_MS).toBe(72 * HOUR);
    expect(ORDER_LOCK_STUCK_AFTER_MS).toBe(30 * MIN);
    expect(RECONCILE_BATCH_LIMIT).toBe(100);
  });

  it('a batch never exceeds the list ceiling; the audit window is a real window', () => {
    expect(RECONCILE_BATCH_LIMIT).toBeLessThanOrEqual(LIST_MAX_LIMIT);
    expect(AUDIT_EFFECTS_MIN_AGE_MS).toBeLessThan(AUDIT_EFFECTS_WINDOW_MS);
  });

  it('the reconciler proof reason is valid in a TON_NOT_SENT proof too', () => {
    const proof = {
      kind: 'TON_NOT_SENT',
      extMsgHash: HASH,
      walletAddress: `0:${HASH}`,
      seqno: 41,
      validUntil: '2030-01-01T09:00:00.000Z',
      checkedSeqno: 41,
      checkedAt: '2030-01-01T09:01:00.000Z',
      reason: RECONCILER_PROOF_REASON,
    };
    expect(NeedsReviewProofSchema.safeParse(proof).success).toBe(true);
    // Control: the same proof without a reason is refused, so the line above tests the reason.
    expect(NeedsReviewProofSchema.safeParse({ ...proof, reason: '' }).success).toBe(false);
  });

  it('the reconciler proof reason is a valid proof reason', () => {
    const proof = {
      kind: 'TON_TX',
      extMsgHash: HASH,
      walletAddress: `0:${HASH}`,
      txHash: HASH,
      lt: '1',
      reason: RECONCILER_PROOF_REASON,
    };
    expect(NeedsReviewProofSchema.safeParse(proof).success).toBe(true);
  });
});
