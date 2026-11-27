import { describe, expect, it } from 'vitest';
import { sumBalance } from '../src/index';
import { db } from './client';
import { expectRefused } from './needs-review-expect';
import {
  OPERATOR,
  PRICE,
  RECONCILER,
  addAttempt,
  addTransfer,
  manualProof,
  moveAttempt,
  moveTransfer,
  notSentProof,
  paidOrder,
  reviewOrder,
  statusOf,
  tonTxProof,
  unmatchedProof,
} from './order-fixtures';
import { resolve } from './order-resolve';

// Phase 5 S9f, audit L-1: the TON module keeps a late chain fact on the attempt (`ton.late`, or
// `ton.lateDestination`) when the chain showed a "not sent" transfer's message after all. Such a
// transfer may keep its EXPIRED status (a late SUSPECT, a late CONFIRMED the seqno index refused),
// but it is no longer PROVABLY not sent: no TON_NOT_SENT may rest on it or beside it, nor may an
// owner proof that needs every other transfer not sent. MANUAL keeps its own rule (every transfer
// EXPIRED): the owner's way out for a late SUSPECT that paid nothing. Beside a CONSUMED_UNMATCHED
// transfer no refund proof is left at all (the safe side; the exit is an open owner question). The Z6
// hint (owner decision 2026-11-18): a CONSUMED_UNMATCHED transfer the hint confirmed (CONFIRMED,
// `late.via = HINT`) is delivered by the owner's TON_TX, never automatically.

const LATE = { ton: { late: { from: 'EXPIRED', outcome: 'SUSPECT', via: 'SCAN' } } };
const LATE_DESTINATION = {
  ton: { lateDestination: { verdict: 'DESTINATION_ABORTED', destTxHash: null } },
};

/** A NEEDS_REVIEW order with one EXPIRED transfer whose attempt carries `response`. */
async function expiredReview(response: object | null) {
  const review = await reviewOrder('EXPIRED', 'FAILED');
  if (response === null) return review;
  const attempt = await db.fulfillmentAttempt.update({
    where: { id: review.attempt.id },
    data: { response },
  });
  return { ...review, attempt };
}

/**
 * Attempt 1 EXPIRED (FAILED) with `firstResponse`, then attempt 2 with a transfer in `second`
 * (attempt UNKNOWN), the order NEEDS_REVIEW: the reviewed transfer is the second one.
 */
async function twoTransfers(firstResponse: object, second: 'EXPIRED' | 'CONSUMED_UNMATCHED') {
  const base = await paidOrder('PROCESSING');
  const first = await addAttempt(base.order.id, 'SENDING');
  await addTransfer(first.id, 'EXPIRED');
  await moveAttempt(first.id, 'FAILED');
  await db.fulfillmentAttempt.update({
    where: { id: first.id },
    data: { response: firstResponse },
  });
  const sending = await addAttempt(base.order.id, 'SENDING', { attemptNo: 2 });
  const transfer = await addTransfer(sending.id, second);
  const attempt = await moveAttempt(sending.id, second === 'EXPIRED' ? 'FAILED' : 'UNKNOWN');
  const order = await db.order.update({
    where: { id: base.order.id },
    data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
  });
  return { ...base, order, attempt, transfer };
}

describe('a late chain fact makes "not sent" unprovable (S9f L-1)', () => {
  it('TON_NOT_SENT on an EXPIRED transfer with `late` or `lateDestination`: LIVE_PAYOUT, whoever carries it', async () => {
    for (const response of [LATE, LATE_DESTINATION]) {
      const review = await expiredReview(response);
      for (const resolver of [RECONCILER, OPERATOR]) {
        await expectRefused(
          review,
          'FAILED',
          notSentProof(review.transfer),
          resolver,
          'LIVE_PAYOUT',
          `TON_NOT_SENT with ${Object.keys(response.ton).join()} by ${resolver.kind}`,
        );
      }
    }
  });

  it('control: the same EXPIRED transfer without a late fact is refunded by TON_NOT_SENT', async () => {
    const review = await expiredReview(null);
    const result = await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: notSentProof(review.transfer),
      resolver: RECONCILER,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });

  it('TON_NOT_SENT on a clean transfer beside an earlier one with a late fact: LIVE_PAYOUT', async () => {
    const review = await twoTransfers(LATE, 'EXPIRED');
    await expectRefused(
      review,
      'FAILED',
      notSentProof(review.transfer),
      RECONCILER,
      'LIVE_PAYOUT',
      'TON_NOT_SENT beside a late transfer',
    );
  });

  it('an owner proof needs every other transfer provably not sent; beside a CU no refund is left', async () => {
    const review = await twoTransfers(LATE, 'CONSUMED_UNMATCHED');
    await expectRefused(
      review,
      'FAILED',
      unmatchedProof(review.transfer),
      OPERATOR,
      'LIVE_PAYOUT',
      'TON_UNMATCHED_RESOLVED beside a late transfer',
    );
    // MANUAL FAILED needs every transfer EXPIRED (unchanged): the CU one is not.
    await expectRefused(
      review,
      'FAILED',
      manualProof,
      OPERATOR,
      'LIVE_PAYOUT',
      'MANUAL beside a CONSUMED_UNMATCHED transfer',
    );
    expect(await statusOf(review.order.id)).toBe('NEEDS_REVIEW');
  });

  it('MANUAL stays the way out for a lone late SUSPECT transfer (every transfer EXPIRED)', async () => {
    const review = await expiredReview(LATE);
    const result = await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: manualProof,
      resolver: OPERATOR,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await sumBalance(db, review.user.id)).toBe(0n);
  });
});

describe('Z6 is manual: the owner delivers a hint-confirmed transfer with TON_TX', () => {
  it('CONSUMED_UNMATCHED -> CONFIRMED by the hint (late.via = HINT): TON_TX delivers the order', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    const confirmed = await moveTransfer(review.transfer.id, 'CONFIRMED');
    await db.fulfillmentAttempt.update({
      where: { id: review.attempt.id },
      data: {
        response: {
          ton: {
            late: { from: 'CONSUMED_UNMATCHED', outcome: 'CONFIRMED', via: 'HINT' },
            hint: { auditId: 'audit-1', verdict: 'ACCEPTED' },
          },
        },
      },
    });
    await resolve({
      orderId: review.order.id,
      to: 'DELIVERED',
      proof: tonTxProof(confirmed),
      resolver: OPERATOR,
    });
    expect(await statusOf(review.order.id)).toBe('DELIVERED');
    expect(
      (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: review.attempt.id } })).status,
    ).toBe('CONFIRMED');
    expect(await sumBalance(db, review.user.id)).toBe(-PRICE);
  });
});
