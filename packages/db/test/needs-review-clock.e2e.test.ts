import { FULFILL_ORDER_LOCK_DURATION_MS, TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  ReviewProofError,
  resolveNeedsReview,
  sumBalance,
  type ReviewProofProblem,
} from '../src/index';
import { db } from './client';
import {
  OPERATOR,
  PRICE,
  RECONCILER,
  addAttempt,
  captureError,
  manualProof,
  notSentProof,
  paidOrder,
  refunds,
  reviewOrder,
  statusOf,
} from './order-fixtures';
import { resolve, type ResolveInput } from './order-resolve';

// Auditor choice 1 and audit N2, review R9: the transfer-less SENDING attempt waits for
// `lockDuration + margin` before an operator may call it "never sent", the clock of the helper is the
// database's, and an operator id that is not text is refused.

type Review = Awaited<ReturnType<typeof reviewOrder>>;

async function expectRefused(
  review: Review,
  to: 'DELIVERED' | 'FAILED',
  proof: unknown,
  resolver: ResolveInput['resolver'],
  problem: ReviewProofProblem,
  label: string,
  clock?: Date,
): Promise<void> {
  const error = await captureError(
    resolve({ orderId: review.order.id, to, proof, resolver }, clock),
  );
  expect(error, label).toBeInstanceOf(ReviewProofError);
  expect((error as ReviewProofError).problem, label).toBe(problem);
  expect(await statusOf(review.order.id), label).toBe('NEEDS_REVIEW');
  expect(await sumBalance(db, review.user.id), label).toBe(-PRICE);
  expect(await db.auditLog.count({ where: { targetId: review.order.id } }), label).toBe(0);
  expect(await refunds(review.order.id), label).toHaveLength(0);
}

describe('a transfer-less SENDING attempt: its worker may still be running (auditor choice 1)', () => {
  const quiet = FULFILL_ORDER_LOCK_DURATION_MS + TON_NOT_SENT_MARGIN_MS;

  async function sendingReview() {
    const base = await paidOrder('PROCESSING');
    const attempt = await addAttempt(base.order.id, 'SENDING');
    const order = await db.order.update({
      where: { id: base.order.id },
      data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
    });
    return { ...base, order, attempt, transfer: undefined } as unknown as Review;
  }

  it('MANUAL -> FAILED is refused until lockDuration + margin after the attempt was created', async () => {
    const review = await sendingReview();
    const born = review.attempt.createdAt.getTime();
    for (const age of [0, 1_000, quiet - 1]) {
      await expectRefused(
        review,
        'FAILED',
        manualProof,
        OPERATOR,
        'LIVE_PAYOUT',
        `${age} ms old`,
        new Date(born + age),
      );
    }
    await resolve(
      { orderId: review.order.id, to: 'FAILED', proof: manualProof, resolver: OPERATOR },
      new Date(born + quiet),
    );
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });

  it('MANUAL -> DELIVERED does not wait: the operator saw the goods arrive', async () => {
    const review = await sendingReview();
    await resolve(
      { orderId: review.order.id, to: 'DELIVERED', proof: manualProof, resolver: OPERATOR },
      new Date(review.attempt.createdAt.getTime()),
    );
    expect(await statusOf(review.order.id)).toBe('DELIVERED');
  });

  it('an UNKNOWN attempt (the worker ended) is not held back', async () => {
    const review = await reviewOrder('EXPIRED');
    await resolve(
      { orderId: review.order.id, to: 'FAILED', proof: manualProof, resolver: OPERATOR },
      new Date(review.attempt.createdAt.getTime()),
    );
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });
});

describe('the clock is the database clock (N2); an operator id must be text (R9)', () => {
  it('the public helper takes no clock: a proof checked in the future is refused by the real one', async () => {
    const review = await reviewOrder('EXPIRED');
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const error = await captureError(
      db.$transaction((tx) =>
        resolveNeedsReview(tx, {
          orderId: review.order.id,
          to: 'FAILED',
          proof: notSentProof(review.transfer, { checkedAt: future }),
          resolver: RECONCILER,
        }),
      ),
    );
    expect((error as ReviewProofError).problem).toBe('MISMATCH');
    expect(await statusOf(review.order.id)).toBe('NEEDS_REVIEW');
  });

  it('the public helper accepts a proof checked just after the margin (the fixture validUntil is long past)', async () => {
    const review = await reviewOrder('EXPIRED');
    await db.$transaction((tx) =>
      resolveNeedsReview(tx, {
        orderId: review.order.id,
        to: 'FAILED',
        proof: notSentProof(review.transfer),
        resolver: RECONCILER,
      }),
    );
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });

  it.each([null, undefined, 42, {}])(
    'an operator whose id is %j is OPERATOR_REQUIRED, not a TypeError',
    async (id) => {
      const review = await reviewOrder('EXPIRED');
      const error = await captureError(
        resolve({
          orderId: review.order.id,
          to: 'FAILED',
          proof: manualProof,
          resolver: { ...OPERATOR, id } as unknown as ResolveInput['resolver'],
        }),
      );
      expect(error).toBeInstanceOf(ReviewProofError);
      expect((error as ReviewProofError).problem).toBe('OPERATOR_REQUIRED');
    },
  );
});
