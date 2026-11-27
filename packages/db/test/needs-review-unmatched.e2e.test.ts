import { describe, expect, it } from 'vitest';
import { sumBalance } from '../src/index';
import { db } from './client';
import { expectRefused } from './needs-review-expect';
import {
  OPERATOR,
  PRICE,
  RECONCILER,
  bouncedProof,
  manualProof,
  notDebitedProof,
  notSentProof,
  refunds,
  reviewOrder,
  statusOf,
  uniqueHash,
  unmatchedProof,
} from './order-fixtures';
import { resolve } from './order-resolve';

// Owner decision A3 (D-59): a CONSUMED_UNMATCHED transfer (the seqno went to a transaction that is
// not ours) is refunded only after a human looked at the chain and said what they found, through an
// OWNER's TON_UNMATCHED_RESOLVED proof with the OTP, from the owner CLI (no automatic path). It
// replaces the earlier "no refund path" decision (R2).

describe('TON_UNMATCHED_RESOLVED: the owner refunds after looking at the chain', () => {
  it('NOT_SENT: FAILED then REFUNDED, one refund, audit with the finding, no security alert', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    const proof = unmatchedProof(review.transfer);
    const result = await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof,
      resolver: OPERATOR,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(result.securityAlert).toBeNull();
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
    expect(await sumBalance(db, review.user.id)).toBe(0n);
    expect(await refunds(review.order.id)).toHaveLength(1);
    expect(
      (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: review.attempt.id } })).status,
    ).toBe('FAILED');
    expect(
      (await db.tonTransfer.findUniqueOrThrow({ where: { id: review.transfer.id } })).status,
    ).toBe('CONSUMED_UNMATCHED');
    const [audit] = await db.auditLog.findMany({ where: { targetId: review.order.id } });
    expect(audit).toMatchObject({
      action: 'ORDER_REVIEW_RESOLVE',
      after: {
        proof: {
          kind: 'TON_UNMATCHED_RESOLVED',
          transferId: review.transfer.id,
          finding: 'NOT_SENT',
          consumingTxHash: proof.consumingTxHash,
        },
        operator: { role: 'OWNER' },
        otpVerified: true,
      },
    });
  });

  it('SENT_ELSEWHERE refunds the customer too, and asks the caller for the critical wallet-compromised alert', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    const result = await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: unmatchedProof(review.transfer, { finding: 'SENT_ELSEWHERE' }),
      resolver: OPERATOR,
    });
    expect(result.securityAlert).toBe('tonWalletCompromised');
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });

  it('only an OWNER who typed the OTP, and never the reconciler: there is no automatic path', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    const proof = unmatchedProof(review.transfer);
    await expectRefused(
      review,
      'FAILED',
      proof,
      { ...OPERATOR, otpVerified: false },
      'OWNER_REQUIRED',
      'no otp',
    );
    await expectRefused(review, 'FAILED', proof, RECONCILER, 'ACTOR_MISMATCH', 'reconciler');
  });

  it('it never delivers, and it does not fit a transfer that is not CONSUMED_UNMATCHED', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    await expectRefused(
      review,
      'DELIVERED',
      unmatchedProof(review.transfer),
      OPERATOR,
      'WRONG_KIND',
      'delivers',
    );
    for (const status of [
      'SIGNED',
      'BROADCAST',
      'CONFIRMED',
      'EXPIRED',
      'ONCHAIN_FAILED',
      'BOUNCED',
    ] as const) {
      const other = await reviewOrder(status);
      await expectRefused(
        other,
        'FAILED',
        unmatchedProof(other.transfer),
        OPERATOR,
        'MISMATCH',
        status,
      );
    }
  });

  it('refuses a finding outside the two, a malformed hash, a thin reason and extra keys', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    const bad: Record<string, unknown>[] = [
      { finding: 'DELIVERED' },
      { finding: undefined },
      { consumingTxHash: 'abc' },
      { consumingTxHash: undefined },
      { reason: 'checked' },
      { transferId: undefined },
      { actor: 'owner' },
    ];
    for (const override of bad) {
      await expectRefused(
        review,
        'FAILED',
        unmatchedProof(review.transfer, override),
        OPERATOR,
        'INVALID',
        JSON.stringify(override),
      );
    }
  });

  it("another order's unmatched transfer is not this order's proof", async () => {
    const mine = await reviewOrder('CONSUMED_UNMATCHED');
    const theirs = await reviewOrder('CONSUMED_UNMATCHED');
    await expectRefused(
      mine,
      'FAILED',
      unmatchedProof(theirs.transfer),
      OPERATOR,
      'MISMATCH',
      'foreign',
    );
  });

  it('the consuming transaction is an UNKNOWN one: it cannot be the hash of a transfer of ours', async () => {
    const unmatched = await reviewOrder('CONSUMED_UNMATCHED');
    const paid = await reviewOrder('CONFIRMED');
    await expectRefused(
      unmatched,
      'FAILED',
      unmatchedProof(unmatched.transfer, { consumingTxHash: paid.transfer.txHash }),
      OPERATOR,
      'MISMATCH',
      'our own transaction',
    );
  });

  it('no other proof refunds it: MANUAL, TON_NOT_SENT, TON_BOUNCED and TON_NOT_DEBITED all stay refused', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    await expectRefused(review, 'FAILED', manualProof, OPERATOR, 'LIVE_PAYOUT', 'manual');
    await expectRefused(
      review,
      'FAILED',
      notSentProof(review.transfer),
      RECONCILER,
      'MISMATCH',
      'not sent',
    );
    await expectRefused(
      review,
      'FAILED',
      bouncedProof(review.transfer, { txHash: uniqueHash() }),
      OPERATOR,
      'MISMATCH',
      'bounced',
    );
    await expectRefused(
      review,
      'FAILED',
      notDebitedProof(review.transfer, { txHash: uniqueHash() }),
      OPERATOR,
      'MISMATCH',
      'not debited',
    );
  });
});
