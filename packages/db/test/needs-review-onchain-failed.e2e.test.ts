import { describe, expect, it } from 'vitest';
import {
  LivePayoutError,
  failAndRefundOrder,
  refundFailedOrder,
  sumBalance,
  transitionOrder,
} from '../src/index';
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
  notDebitedProof,
  notSentProof,
  paidOrder,
  refunds,
  reviewOrder,
  statusOf,
} from './order-fixtures';
import { resolve } from './order-resolve';

// Owner decision A2 (D-59): an ONCHAIN_FAILED transfer is a failed ACTION PHASE: our transaction ran
// but sent no message, so the value never left the wallet. The way out towards a refund is an
// OWNER's TON_NOT_DEBITED proof with the OTP. (A bounce is a different thing: needs-review-bounced.)

describe('TON_NOT_DEBITED: the owner refunds a payout whose action phase failed', () => {
  it('ONCHAIN_FAILED + the proof + the owner with the OTP: FAILED then REFUNDED, one refund, audit', async () => {
    const review = await reviewOrder('ONCHAIN_FAILED');
    const result = await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: notDebitedProof(review.transfer),
      resolver: OPERATOR,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
    expect(await sumBalance(db, review.user.id)).toBe(0n);
    expect(await refunds(review.order.id)).toHaveLength(1);
    expect(
      (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: review.attempt.id } })).status,
    ).toBe('FAILED');
    expect(
      (await db.tonTransfer.findUniqueOrThrow({ where: { id: review.transfer.id } })).status,
    ).toBe('ONCHAIN_FAILED');
    const [audit] = await db.auditLog.findMany({ where: { targetId: review.order.id } });
    expect(audit).toMatchObject({
      action: 'ORDER_REVIEW_RESOLVE',
      after: {
        proof: { kind: 'TON_NOT_DEBITED', transferId: review.transfer.id, outMsgCount: 0 },
        operator: { role: 'OWNER' },
        otpVerified: true,
      },
    });
  });

  it('only an OWNER who typed the OTP: no OTP or the reconciler is refused', async () => {
    const review = await reviewOrder('ONCHAIN_FAILED');
    const proof = notDebitedProof(review.transfer);
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

  it('it never delivers, and it does not fit a transfer that is not ONCHAIN_FAILED (a bounce included)', async () => {
    const review = await reviewOrder('ONCHAIN_FAILED');
    await expectRefused(
      review,
      'DELIVERED',
      notDebitedProof(review.transfer),
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
      'BOUNCED',
    ] as const) {
      const other = await reviewOrder(status);
      await expectRefused(
        other,
        'FAILED',
        notDebitedProof(
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
    ['another logical time', () => ({ txLt: '1' })],
  ])('%s is refused', async (label, override) => {
    const review = await reviewOrder('ONCHAIN_FAILED');
    const proof = notDebitedProof(review.transfer, override(review.transfer));
    await expectRefused(review, 'FAILED', proof, OPERATOR, 'MISMATCH', label);
  });

  it('a transaction that DID send a message is not this proof (outMsgCount must be 0)', async () => {
    const review = await reviewOrder('ONCHAIN_FAILED');
    for (const outMsgCount of [1, 2, '0', null]) {
      await expectRefused(
        review,
        'FAILED',
        notDebitedProof(review.transfer, { outMsgCount }),
        OPERATOR,
        'INVALID',
        String(outMsgCount),
      );
    }
  });

  it('the proof of a bounce does not open a failed action phase, and the other way round', async () => {
    const failed = await reviewOrder('ONCHAIN_FAILED');
    await expectRefused(
      failed,
      'FAILED',
      bouncedProof(failed.transfer),
      OPERATOR,
      'MISMATCH',
      'bounce proof on ONCHAIN_FAILED',
    );
    const bounced = await reviewOrder('BOUNCED');
    await expectRefused(
      bounced,
      'FAILED',
      notDebitedProof(bounced.transfer),
      OPERATOR,
      'MISMATCH',
      'not-debited proof on BOUNCED',
    );
  });

  it("another order's failed transfer is not this order's proof", async () => {
    const mine = await reviewOrder('ONCHAIN_FAILED');
    const theirs = await reviewOrder('ONCHAIN_FAILED');
    await expectRefused(
      mine,
      'FAILED',
      notDebitedProof(theirs.transfer),
      OPERATOR,
      'MISMATCH',
      'foreign',
    );
  });

  it('another payout of the order that is alive blocks it (LIVE_PAYOUT)', async () => {
    const review = await reviewOrder('ONCHAIN_FAILED');
    const second = await forceAttempt(review.order.id, 'FAILED', { attemptNo: 2 });
    await forceTransfer(second.id, 'CONFIRMED');
    await expectRefused(
      review,
      'FAILED',
      notDebitedProof(review.transfer),
      OPERATOR,
      'LIVE_PAYOUT',
      'second transfer',
    );
    const base = await paidOrder('NEEDS_REVIEW');
    await db.order.update({
      where: { id: base.order.id },
      data: { statusReason: 'CONFIRM_TIMEOUT' },
    });
    const failedAttempt = await forceAttempt(base.order.id, 'FAILED');
    const failed = await forceTransfer(failedAttempt.id, 'ONCHAIN_FAILED');
    const live = await forceAttempt(base.order.id, 'UNKNOWN', { attemptNo: 2 });
    const withAttempt: Review = { ...base, attempt: live, transfer: failed };
    await expectRefused(
      withAttempt,
      'FAILED',
      notDebitedProof(failed),
      OPERATOR,
      'LIVE_PAYOUT',
      'second attempt',
    );
  });

  it('MANUAL evidence and TON_NOT_SENT cannot get round it: a failed-on-chain transfer still blocks', async () => {
    const review = await reviewOrder('ONCHAIN_FAILED');
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

  it('the plain helpers refuse a failed-on-chain transfer: only the proof path is open', async () => {
    const held = await paidOrder('PROCESSING');
    const attempt = await forceAttempt(held.order.id, 'FAILED');
    await forceTransfer(attempt.id, 'ONCHAIN_FAILED');
    const toHeld = await captureError(
      db.$transaction((tx) =>
        transitionOrder(tx, {
          orderId: held.order.id,
          from: 'PROCESSING',
          to: 'HELD',
          actor: 'system',
          reason: 'ADAPTER_ERROR',
        }),
      ),
    );
    expect(toHeld).toBeInstanceOf(LivePayoutError);
    expect((toHeld as LivePayoutError).detail).toContain('ONCHAIN_FAILED');
    const toFailed = await captureError(
      db.$transaction((tx) =>
        failAndRefundOrder(tx, {
          orderId: held.order.id,
          from: 'PROCESSING',
          reason: 'ADAPTER_ERROR',
          actor: 'system',
        }),
      ),
    );
    expect(toFailed).toBeInstanceOf(LivePayoutError);
    const stuck = await paidOrder('FAILED');
    const closed = await forceAttempt(stuck.order.id, 'FAILED');
    await forceTransfer(closed.id, 'ONCHAIN_FAILED');
    const refund = await captureError(
      db.$transaction((tx) => refundFailedOrder(tx, { orderId: stuck.order.id, actor: 'system' })),
    );
    expect(refund).toBeInstanceOf(LivePayoutError);
    expect(await refunds(stuck.order.id)).toHaveLength(0);
  });
});
