import { describe, expect, it } from 'vitest';
import { ReviewProofError } from '../src/index';
import { db } from './client';
import { OPERATOR, captureError, reviewOrder, statusOf, tonTxProof } from './order-fixtures';
import { resolve, type ResolveInput } from './order-resolve';

// The operator's confirmations (`acknowledgements`, stored in the audit row's `after`) are a closed
// list (re-review N3): JS callers are not type-checked, so an unknown value or a non-array is
// refused before anything is written, and a repeated value is stored once.

const audit = (orderId: string) => db.auditLog.findMany({ where: { targetId: orderId } });

describe('resolveNeedsReview acknowledgements', () => {
  it.each([
    ['an unknown value', ['DELIVERED_OUTSIDE_SYSTEM', 'SOMETHING_ELSE']],
    ['a value that is not an array', 'DELIVERED_OUTSIDE_SYSTEM'],
    ['an object', { 0: 'DELIVERED_OUTSIDE_SYSTEM' }],
  ])('%s is refused (INVALID) and nothing is written', async (_label, acknowledgements) => {
    const review = await reviewOrder('CONFIRMED');
    const error = await captureError(
      resolve({
        orderId: review.order.id,
        to: 'DELIVERED',
        proof: tonTxProof(review.transfer),
        resolver: OPERATOR,
        acknowledgements,
      } as unknown as ResolveInput),
    );
    expect(error).toBeInstanceOf(ReviewProofError);
    expect((error as ReviewProofError).problem).toBe('INVALID');
    expect(await statusOf(review.order.id)).toBe('NEEDS_REVIEW');
    expect(
      (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: review.attempt.id } })).status,
    ).toBe(review.attempt.status);
    expect(await audit(review.order.id)).toHaveLength(0);
  });

  it('a repeated value is stored once; none given stores an empty list', async () => {
    const twice = await reviewOrder('CONFIRMED');
    await resolve({
      orderId: twice.order.id,
      to: 'DELIVERED',
      proof: tonTxProof(twice.transfer),
      resolver: OPERATOR,
      acknowledgements: ['DELIVERED_OUTSIDE_SYSTEM', 'DELIVERED_OUTSIDE_SYSTEM'],
    });
    const [row] = await audit(twice.order.id);
    expect(row?.after).toMatchObject({ acknowledgements: ['DELIVERED_OUTSIDE_SYSTEM'] });

    const none = await reviewOrder('CONFIRMED');
    await resolve({
      orderId: none.order.id,
      to: 'DELIVERED',
      proof: tonTxProof(none.transfer),
      resolver: OPERATOR,
    });
    const [plain] = await audit(none.order.id);
    expect(plain?.after).toMatchObject({ acknowledgements: [] });
  });
});
