import { TON_BOUNCE_FEE_MAX_NANO } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { ReviewProofError, sumBalance } from '../src/index';
import { db } from './client';
import { expectRefused, type Review } from './needs-review-expect';
import {
  OPERATOR,
  PRICE,
  RECONCILER,
  bouncedProof,
  captureError,
  forceAttempt,
  forceTransfer,
  manualProof,
  notSentProof,
  paidOrder,
  refunds,
  reviewOrder,
  statusOf,
} from './order-fixtures';
import { resolve } from './order-resolve';

// Owner decision A1 (D-59): the destination aborted our message and the value CAME BACK. The
// transfer is BOUNCED (its txHash/txLt are OUR transaction), the order can never be DELIVERED, and
// it leaves NEEDS_REVIEW towards a refund only through an OWNER's TON_BOUNCED proof with the OTP.

const sent = 235_000_000n; // the fixture transfers' amountNanoTon

describe('TON_BOUNCED: the owner refunds a payout whose value came back', () => {
  it('BOUNCED + the bounce + the owner with the OTP: FAILED then REFUNDED, attempt closed, one refund, audit', async () => {
    const review = await reviewOrder('BOUNCED');
    const proof = bouncedProof(review.transfer);
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
    // The transfer stays what it is: the chain says it bounced.
    expect(
      (await db.tonTransfer.findUniqueOrThrow({ where: { id: review.transfer.id } })).status,
    ).toBe('BOUNCED');
    const [audit] = await db.auditLog.findMany({ where: { targetId: review.order.id } });
    expect(audit).toMatchObject({
      action: 'ORDER_REVIEW_RESOLVE',
      after: {
        proof: {
          kind: 'TON_BOUNCED',
          transferId: review.transfer.id,
          returnTxHash: proof.returnTxHash,
        },
        operator: { type: 'CLI', id: 'owner-1', role: 'OWNER' },
        otpVerified: true,
      },
    });
  });

  it('the returned amount may be anything from sent - TON_BOUNCE_FEE_MAX_NANO up to sent (both ends)', async () => {
    for (const returned of [sent, sent - TON_BOUNCE_FEE_MAX_NANO]) {
      const review = await reviewOrder('BOUNCED');
      await resolve({
        orderId: review.order.id,
        to: 'FAILED',
        proof: bouncedProof(review.transfer, { returnedNanoTon: returned.toString() }),
        resolver: OPERATOR,
      });
      expect(await statusOf(review.order.id), returned.toString()).toBe('REFUNDED');
    }
  });

  it('it never delivers, and it does not fit a transfer that is not BOUNCED (including ONCHAIN_FAILED)', async () => {
    const review = await reviewOrder('BOUNCED');
    await expectRefused(
      review,
      'DELIVERED',
      bouncedProof(review.transfer),
      OPERATOR,
      'WRONG_KIND',
      'delivers',
    );
    for (const status of [
      'SIGNED',
      'BROADCAST',
      'CONFIRMED',
      'EXPIRED',
      'CONSUMED_UNMATCHED',
      'ONCHAIN_FAILED',
    ] as const) {
      const other = await reviewOrder(status);
      await expectRefused(
        other,
        'FAILED',
        bouncedProof(
          other.transfer,
          other.transfer.txHash === null ? { txHash: 'a'.repeat(64) } : {},
        ),
        OPERATOR,
        'MISMATCH',
        status,
      );
    }
  });

  it.each([
    ['another transfer id', (t: { id: string }) => ({ transferId: t.id + 'x' })],
    ['another transaction hash', () => ({ txHash: 'a'.repeat(64) })],
    ['another logical time', () => ({ txLt: '1', returnLt: '2' })],
    [
      'more returned than was sent (review P5)',
      () => ({ returnedNanoTon: (sent + 1n).toString() }),
    ],
    [
      'a bounce of 1 nanoTON: the money did not come back (audit R2d)',
      () => ({ returnedNanoTon: '1' }),
    ],
    [
      'one nanoTON below the fee ceiling',
      () => ({ returnedNanoTon: (sent - TON_BOUNCE_FEE_MAX_NANO - 1n).toString() }),
    ],
  ])('%s is refused', async (label, override) => {
    const review = await reviewOrder('BOUNCED');
    const proof = bouncedProof(review.transfer, override(review.transfer));
    await expectRefused(review, 'FAILED', proof, OPERATOR, 'MISMATCH', label);
  });

  it('the bounce must come after our transaction and be another one (audit R2d: returnLt = 0)', async () => {
    const review = await reviewOrder('BOUNCED');
    for (const returnLt of ['0', review.transfer.txLt?.toString() ?? '']) {
      await expectRefused(
        review,
        'FAILED',
        bouncedProof(review.transfer, { returnLt }),
        OPERATOR,
        'INVALID',
        `returnLt ${returnLt}`,
      );
    }
    await expectRefused(
      review,
      'FAILED',
      bouncedProof(review.transfer, { returnTxHash: review.transfer.txHash }),
      OPERATOR,
      'INVALID',
      'the transaction itself as its own bounce',
    );
  });

  it("another order's bounced transfer is not this order's proof", async () => {
    const mine = await reviewOrder('BOUNCED');
    const theirs = await reviewOrder('BOUNCED');
    await expectRefused(
      mine,
      'FAILED',
      bouncedProof(theirs.transfer),
      OPERATOR,
      'MISMATCH',
      'foreign',
    );
  });

  it('only an OWNER who typed the OTP: no OTP or the reconciler is refused', async () => {
    const review = await reviewOrder('BOUNCED');
    const proof = bouncedProof(review.transfer);
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

  it('another payout of the order that is alive blocks it (LIVE_PAYOUT)', async () => {
    const withTransfer = await reviewOrder('BOUNCED');
    const second = await forceAttempt(withTransfer.order.id, 'FAILED', { attemptNo: 2 });
    await forceTransfer(second.id, 'CONFIRMED');
    await expectRefused(
      withTransfer,
      'FAILED',
      bouncedProof(withTransfer.transfer),
      OPERATOR,
      'LIVE_PAYOUT',
      'second transfer',
    );
    // The failed attempt 1 owns the bounced transfer; attempt 2 is alive (the unique index allows one).
    const base = await paidOrder('NEEDS_REVIEW');
    await db.order.update({
      where: { id: base.order.id },
      data: { statusReason: 'CONFIRM_TIMEOUT' },
    });
    const failedAttempt = await forceAttempt(base.order.id, 'FAILED');
    const bounced = await forceTransfer(failedAttempt.id, 'BOUNCED');
    const live = await forceAttempt(base.order.id, 'UNKNOWN', { attemptNo: 2 });
    const withAttempt: Review = { ...base, attempt: live, transfer: bounced };
    await expectRefused(
      withAttempt,
      'FAILED',
      bouncedProof(bounced),
      OPERATOR,
      'LIVE_PAYOUT',
      'second attempt',
    );
  });

  it('MANUAL evidence and TON_NOT_SENT cannot get round it: a bounced transfer still blocks', async () => {
    const review = await reviewOrder('BOUNCED');
    await expectRefused(review, 'FAILED', manualProof, OPERATOR, 'LIVE_PAYOUT', 'manual');
    await expectRefused(
      review,
      'FAILED',
      notSentProof(review.transfer),
      RECONCILER,
      'MISMATCH',
      'not sent',
    );
  });

  it('a NEEDS_REVIEW order with a bounced transfer never delivers, by any proof', async () => {
    const review = await reviewOrder('BOUNCED');
    const error = await captureError(
      resolve({
        orderId: review.order.id,
        to: 'DELIVERED',
        proof: manualProof,
        resolver: OPERATOR,
      }),
    );
    expect(error).toBeInstanceOf(ReviewProofError);
    expect((error as ReviewProofError).problem).toBe('LIVE_PAYOUT');
    expect(await statusOf(review.order.id)).toBe('NEEDS_REVIEW');
  });
});
