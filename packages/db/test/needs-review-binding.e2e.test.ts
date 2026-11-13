import { describe, expect, it } from 'vitest';
import { ReviewProofError, sumBalance, type ReviewProofProblem } from '../src/index';
import { db } from './client';
import {
  NOW,
  PRICE,
  RECONCILER,
  captureError,
  forceAttempt,
  forceTransfer,
  notSentProof,
  reviewOrder,
  statusOf,
} from './order-fixtures';
import { resolve, type ResolveInput } from './order-resolve';

// Audit H1 / review F6, F12: a proof that agrees only with itself proves nothing. Each case
// below is a proof the helper must refuse because the ORDER's own rows say otherwise.

let wallets = 0;
const wallet = () => `0:${(++wallets).toString(16).padStart(64, 'e')}`;

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

describe('B: a fabricated TON_NOT_SENT cannot refund a payout that is on the chain', () => {
  it('the transfer is CONFIRMED: refused, no refund, no audit row', async () => {
    const review = await reviewOrder('CONFIRMED');
    await expectRefused(
      review,
      'FAILED',
      notSentProof(review.transfer),
      RECONCILER,
      'MISMATCH',
      'confirmed',
    );
  });

  it.each(['SIGNED', 'BROADCAST', 'CONSUMED_UNMATCHED', 'ONCHAIN_FAILED'] as const)(
    'the transfer is %s, not provably EXPIRED: refused',
    async (status) => {
      const review = await reviewOrder(status);
      await expectRefused(
        review,
        'FAILED',
        notSentProof(review.transfer),
        RECONCILER,
        'MISMATCH',
        status,
      );
    },
  );
});

describe('TON_NOT_SENT must match the stored transfer exactly', () => {
  it.each([
    ['another message hash', { extMsgHash: 'f'.repeat(64) }],
    ['another wallet', { walletAddress: '0:' + '9'.repeat(64) }],
    ['another seqno (consistent inside the proof)', { seqno: 42, checkedSeqno: 42 }],
    [
      'another validUntil',
      { validUntil: '2026-11-11T10:02:00.000Z', checkedAt: '2026-11-11T10:03:00.000Z' },
    ],
  ])('%s is refused', async (label, override) => {
    const review = await reviewOrder('EXPIRED');
    await expectRefused(
      review,
      'FAILED',
      notSentProof(review.transfer, override),
      RECONCILER,
      'MISMATCH',
      label,
    );
  });

  it('a check dated after the clock is refused, with no skew (audit N2); the margin itself is in the schema', async () => {
    const review = await reviewOrder('EXPIRED');
    for (const ahead of [60_000, 1_000, 1]) {
      await expectRefused(
        review,
        'FAILED',
        notSentProof(review.transfer, { checkedAt: new Date(NOW.getTime() + ahead).toISOString() }),
        RECONCILER,
        'MISMATCH',
        `${ahead} ms ahead`,
      );
    }
    // Exactly "now" is not in the future.
    await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: notSentProof(review.transfer, { checkedAt: NOW.toISOString() }),
      resolver: RECONCILER,
    });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });

  it('the clock must be at least validUntil + the margin: a proof is not valid early (audit N2, B2)', async () => {
    const review = await reviewOrder('EXPIRED');
    const validUntil = review.transfer.validUntil.getTime();
    // One second after validUntil the margin has not passed, even though the proof is well-formed.
    for (const clock of [new Date(validUntil + 1_000), new Date(validUntil + 59_999)]) {
      const error = await captureError(
        resolve(
          {
            orderId: review.order.id,
            to: 'FAILED',
            proof: notSentProof(review.transfer),
            resolver: RECONCILER,
          },
          clock,
        ),
      );
      expect((error as ReviewProofError).problem, clock.toISOString()).toBe('MISMATCH');
    }
    expect(await statusOf(review.order.id)).toBe('NEEDS_REVIEW');
    await resolve(
      {
        orderId: review.order.id,
        to: 'FAILED',
        proof: notSentProof(review.transfer),
        resolver: RECONCILER,
      },
      new Date(validUntil + 60_000),
    );
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });

  it('a checkedAt inside the margin after validUntil is not a proof at all (INVALID)', async () => {
    const review = await reviewOrder('EXPIRED');
    const early = new Date(review.transfer.validUntil.getTime() + 1_000).toISOString();
    await expectRefused(
      review,
      'FAILED',
      notSentProof(review.transfer, { checkedAt: early }),
      RECONCILER,
      'INVALID',
      'inside margin',
    );
  });

  it("another order's transfer is not this order's proof", async () => {
    const mine = await reviewOrder('EXPIRED');
    const theirs = await reviewOrder('EXPIRED');
    await expectRefused(
      mine,
      'FAILED',
      notSentProof(theirs.transfer),
      RECONCILER,
      'MISMATCH',
      'foreign transfer',
    );
  });
});

describe('TON_NOT_SENT with another payout still alive (LIVE_PAYOUT)', () => {
  it.each(['SIGNED', 'BROADCAST', 'CONFIRMED', 'ONCHAIN_FAILED', 'CONSUMED_UNMATCHED'] as const)(
    'another transfer of the order that is %s',
    async (status) => {
      const review = await reviewOrder('EXPIRED');
      // A second payout the database would not have let in (the order is not PROCESSING): forced.
      const second = await forceAttempt(review.order.id, 'FAILED', { attemptNo: 2 });
      await forceTransfer(second.id, status, { wallet: wallet(), seqno: 7 });
      await expectRefused(
        review,
        'FAILED',
        notSentProof(review.transfer),
        RECONCILER,
        'LIVE_PAYOUT',
        status,
      );
    },
  );

  it('another attempt that is CONFIRMED', async () => {
    // One live attempt per order is enforced by the database, so the first one has failed.
    const review = await reviewOrder('EXPIRED', 'FAILED');
    await forceAttempt(review.order.id, 'CONFIRMED', { attemptNo: 2 });
    await expectRefused(
      review,
      'FAILED',
      notSentProof(review.transfer),
      RECONCILER,
      'LIVE_PAYOUT',
      'confirmed attempt',
    );
  });
});
