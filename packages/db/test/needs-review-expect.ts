import { expect } from 'vitest';
import { ReviewProofError, sumBalance, type ReviewProofProblem } from '../src/index';
import { db } from './client';
import { PRICE, captureError, refunds, reviewOrder, statusOf } from './order-fixtures';
import { resolve, type ResolveInput } from './order-resolve';

export type Review = Awaited<ReturnType<typeof reviewOrder>>;

/**
 * The resolution is refused with `problem`, and nothing moved: the order is still NEEDS_REVIEW, its
 * attempt keeps its status, the customer was not refunded and no audit row exists.
 */
export async function expectRefused(
  review: Review,
  to: 'DELIVERED' | 'FAILED',
  proof: unknown,
  resolver: unknown,
  problem: ReviewProofProblem,
  label: string,
  clock?: Date,
): Promise<void> {
  const error = await captureError(
    resolve({ orderId: review.order.id, to, proof, resolver } as ResolveInput, clock),
  );
  expect(error, label).toBeInstanceOf(ReviewProofError);
  expect((error as ReviewProofError).problem, label).toBe(problem);
  expect(await statusOf(review.order.id), label).toBe('NEEDS_REVIEW');
  expect(
    (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: review.attempt.id } })).status,
    label,
  ).toBe(review.attempt.status);
  expect(await sumBalance(db, review.user.id), label).toBe(-PRICE);
  expect(await db.auditLog.count({ where: { targetId: review.order.id } }), label).toBe(0);
  expect(await refunds(review.order.id), label).toHaveLength(0);
}
