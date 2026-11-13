import { describe, expect, it } from 'vitest';
import { ReviewProofError, sumBalance, type ReviewProofProblem } from '../src/index';
import { db } from './client';
import {
  NOW,
  OPERATOR,
  PRICE,
  RECONCILER,
  addAttempt,
  captureError,
  forceAttempt,
  manualProof,
  notSentProof,
  bypassingGuards,
  paidOrder,
  reviewOrder,
  statusOf,
  tonTxProof,
} from './order-fixtures';
import { resolve, type ResolveInput } from './order-resolve';

// Audit H1 / review F6: the second half of the binding matrix (TON_TX, FRAGMENT_STATUS, MANUAL and
// the proof itself). The first half, TON_NOT_SENT, is in needs-review-binding.e2e.test.ts.

type Review = Awaited<ReturnType<typeof reviewOrder>>;

/** Refused with `problem`, and the order, its attempt, the ledger and the audit log are untouched. */
async function expectRefused(
  review: Review,
  to: 'DELIVERED' | 'FAILED',
  proof: unknown,
  resolver: ResolveInput['resolver'],
  problem: ReviewProofProblem,
  label: string,
): Promise<void> {
  const error = await captureError(resolve({ orderId: review.order.id, to, proof, resolver }));
  expect(error, label).toBeInstanceOf(ReviewProofError);
  expect((error as ReviewProofError).problem, label).toBe(problem);
  expect(await statusOf(review.order.id), label).toBe('NEEDS_REVIEW');
  expect(
    (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: review.attempt.id } })).status,
    label,
  ).toBe(review.attempt.status);
  expect(await sumBalance(db, review.user.id), label).toBe(-PRICE);
  expect(await db.auditLog.count({ where: { targetId: review.order.id } }), label).toBe(0);
}

describe('TON_TX must match a CONFIRMED transfer of the order', () => {
  it.each(['SIGNED', 'BROADCAST', 'EXPIRED', 'CONSUMED_UNMATCHED'] as const)(
    'the transfer is %s, not CONFIRMED: refused',
    async (status) => {
      const review = await reviewOrder(status);
      const proof = tonTxProof(review.transfer, { txHash: 'a'.repeat(64), lt: '1' });
      await expectRefused(review, 'DELIVERED', proof, RECONCILER, 'MISMATCH', status);
    },
  );

  it.each([
    ['another txHash', { txHash: 'b'.repeat(64) }],
    ['another lt', { lt: '1' }],
    ['another message hash', { extMsgHash: 'f'.repeat(64) }],
    ['another wallet', { walletAddress: '0:' + '9'.repeat(64) }],
  ])('%s is refused', async (label, override) => {
    const review = await reviewOrder('CONFIRMED');
    await expectRefused(
      review,
      'DELIVERED',
      tonTxProof(review.transfer, override),
      RECONCILER,
      'MISMATCH',
      label,
    );
  });

  it("another order's confirmed transfer is not this order's proof", async () => {
    const mine = await reviewOrder('SIGNED');
    const theirs = await reviewOrder('CONFIRMED');
    await expectRefused(
      mine,
      'DELIVERED',
      tonTxProof(theirs.transfer),
      RECONCILER,
      'MISMATCH',
      'foreign',
    );
  });
});

describe('TON_TX and FRAGMENT_STATUS: the attempt they close must be alive, and the only one (N3, R5)', () => {
  const fragmentProof = (requestRef: string | null) => ({
    kind: 'FRAGMENT_STATUS',
    requestRef: requestRef ?? 'x',
    status: 'DONE',
    observedAt: NOW.toISOString(),
    reason: 'Fragment shows the order as completed',
  });

  it('a FAILED attempt cannot deliver the order, whatever its reference or transfer says', async () => {
    // attempt 1 failed (its transfer EXPIRED); the late find then CONFIRMED the transfer.
    const review = await reviewOrder('EXPIRED', 'FAILED');
    const late = await db.tonTransfer.update({
      where: { id: review.transfer.id },
      data: { status: 'CONFIRMED', txHash: 'c'.repeat(64), txLt: 5n },
    });
    await expectRefused(
      review,
      'DELIVERED',
      tonTxProof(late),
      RECONCILER,
      'MISMATCH',
      'confirmed transfer of a failed attempt',
    );
    await expectRefused(
      review,
      'DELIVERED',
      fragmentProof(review.attempt.externalRef),
      OPERATOR, // FRAGMENT_STATUS is an operator's proof (audit Y4): the reconciler would be ACTOR_MISMATCH
      'MISMATCH',
      'failed attempt reference',
    );
  });

  it('a second live attempt cannot exist at all: the unique index holds even for a corrupt database', async () => {
    // "No other unresolved attempt" is checked by the helper too, but a second live attempt next
    // to the one the proof names is refused by FulfillmentAttempt_order_active_key whatever else
    // is bypassed, so the only reachable "other attempt" cases are the FAILED ones above.
    const review = await reviewOrder('CONFIRMED');
    await expect(forceAttempt(review.order.id, 'SENT', { attemptNo: 2 })).rejects.toThrow(
      'FulfillmentAttempt_order_active_key',
    );
  });

  it('a CONFIRMED attempt in NEEDS_REVIEW is not a state the database lets exist (D-59 N1); a corrupt one is refused, not delivered', async () => {
    // Before N1 an already CONFIRMED attempt could be "delivered with nothing left to close"; now an
    // attempt is CONFIRMED only together with the delivery, so such a row is corruption: forced in
    // (late-bounce exits are in needs-review-late-bounce.e2e.test.ts).
    const review = await reviewOrder('CONFIRMED');
    await bypassingGuards((tx) =>
      tx.fulfillmentAttempt.update({
        where: { id: review.attempt.id },
        data: { status: 'CONFIRMED' },
      }),
    );
    await expectRefused(
      { ...review, attempt: { ...review.attempt, status: 'CONFIRMED' } },
      'DELIVERED',
      tonTxProof(review.transfer),
      RECONCILER,
      'MISMATCH',
      'confirmed attempt',
    );
  });
});

describe('FRAGMENT_STATUS must name an attempt of the order', () => {
  const proof = (requestRef: string) => ({
    kind: 'FRAGMENT_STATUS',
    requestRef,
    status: 'DONE',
    observedAt: NOW.toISOString(),
    reason: 'Fragment shows the order as completed',
  });

  it('an unknown request, and the request of another order, are refused', async () => {
    const mine = await reviewOrder('SIGNED');
    const theirs = await reviewOrder('SIGNED');
    await expectRefused(mine, 'DELIVERED', proof('nope'), OPERATOR, 'MISMATCH', 'unknown');
    await expectRefused(
      mine,
      'DELIVERED',
      proof(theirs.attempt.externalRef ?? 'x'),
      OPERATOR,
      'MISMATCH',
      'foreign',
    );
  });
});

describe('MANUAL cannot refund an order whose rows show money may have gone out', () => {
  it.each(['SIGNED', 'BROADCAST', 'CONFIRMED', 'ONCHAIN_FAILED', 'CONSUMED_UNMATCHED'] as const)(
    'a %s transfer blocks MANUAL -> FAILED',
    async (status) => {
      const review = await reviewOrder(status);
      await expectRefused(review, 'FAILED', manualProof, OPERATOR, 'LIVE_PAYOUT', status);
    },
  );

  it('a CONFIRMED attempt blocks MANUAL -> FAILED', async () => {
    // One live attempt per order is enforced by the database, so the first one has failed.
    const review = await reviewOrder('EXPIRED', 'FAILED');
    await forceAttempt(review.order.id, 'CONFIRMED', { attemptNo: 2 });
    await expectRefused(
      review,
      'FAILED',
      manualProof,
      OPERATOR,
      'LIVE_PAYOUT',
      'confirmed attempt',
    );
  });

  it('with only EXPIRED transfers the operator may refund, and the unresolved attempt is closed', async () => {
    const review = await reviewOrder('EXPIRED');
    await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: manualProof,
      resolver: OPERATOR,
    });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
    expect(
      (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: review.attempt.id } })).status,
    ).toBe('FAILED');
  });

  it('MANUAL -> DELIVERED needs the attempt to have a reference to confirm', async () => {
    // The reference is written once, so an attempt without one is built that way from the start.
    const base = await paidOrder('PROCESSING');
    const attempt = await addAttempt(base.order.id, 'UNKNOWN', { externalRef: null });
    await db.order.update({
      where: { id: base.order.id },
      data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
    });
    const review = { ...base, attempt, transfer: undefined } as unknown as Review;
    await expectRefused(review, 'DELIVERED', manualProof, OPERATOR, 'MISMATCH', 'no reference');
  });
});

describe('the proof itself', () => {
  it('a missing, malformed or wrong-kind proof is refused for both exits', async () => {
    const review = await reviewOrder('EXPIRED');
    const bad: unknown[] = [
      undefined,
      null,
      {},
      'TON_TX',
      { kind: 'TON_TX' },
      notSentProof(review.transfer, { reason: '' }),
    ];
    for (const proof of bad) {
      for (const to of ['DELIVERED', 'FAILED'] as const) {
        await expectRefused(
          review,
          to,
          proof,
          RECONCILER,
          'INVALID',
          JSON.stringify(proof) ?? 'undefined',
        );
      }
    }
    // "Not sent" evidence never delivers; "sent" evidence never refunds.
    await expectRefused(
      review,
      'DELIVERED',
      notSentProof(review.transfer),
      RECONCILER,
      'WRONG_KIND',
      'not-sent delivers',
    );
    const confirmed = await reviewOrder('CONFIRMED');
    await expectRefused(
      confirmed,
      'FAILED',
      tonTxProof(confirmed.transfer),
      RECONCILER,
      'WRONG_KIND',
      'sent refunds',
    );
  });

  it('an order with no attempts and no transfers cannot be refunded on a TON proof', async () => {
    const review = await reviewOrder('EXPIRED');
    const proof = notSentProof(review.transfer);
    // Remove the evidence: the same proof against an order that has none of it.
    const bare = await paidOrder('NEEDS_REVIEW');
    const error = await captureError(
      resolve({ orderId: bare.order.id, to: 'FAILED', proof, resolver: RECONCILER }),
    );
    expect((error as ReviewProofError).problem).toBe('MISMATCH');
    expect(await statusOf(bare.order.id)).toBe('NEEDS_REVIEW');
    expect(await sumBalance(db, bare.user.id)).toBe(-PRICE);
  });
});
