import { describe, expect, it } from 'vitest';
import { expectGuard } from './check-helpers';
import { db } from './client';
import { createUser } from './factories';
import {
  createAuditLog,
  createBankMessage,
  createReview,
  p2pFixture,
  paymentData,
} from './payments-factories';

// Payment and PaymentReview are mutable tables, but only in the columns their life needs:
// a payment is cancelled (reversal), a review is resolved. Everything that says WHAT the row is
// stays as it was written (triggers, GG001).

/** A CLICK payment credited from a review: no intent, no bank message, easy to vary. */
async function reviewPayment(userId: string, n: number) {
  const review = await createReview();
  return db.payment.create({
    data: paymentData(userId, 'unused', {
      provider: 'CLICK',
      bankMessageId: null,
      reviewId: review.id,
      providerTxnId: `click-immutable-${n}`,
    }),
  });
}

describe('Payment is immutable except status, cancelledAt, confirmedAt and raw', () => {
  it('refuses to rewrite the intent, user, provider, txn id, amount, message or review', async () => {
    const user = await createUser();
    const stranger = await createUser();
    const payment = await reviewPayment(user.id, 1);
    const clickIntent = await db.paymentIntent.create({
      data: {
        userId: user.id,
        provider: 'CLICK',
        amountTiyin: 5_012_300n,
        purpose: 'TOPUP',
        idempotencyKey: 'click-immutable',
        requestHash: 'h',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const message = await createBankMessage();
    const otherReview = await createReview();
    const changes = [
      { intentId: clickIntent.id },
      { userId: stranger.id },
      { provider: 'PAYME' as const },
      { providerTxnId: 'rewritten' },
      { amountTiyin: payment.amountTiyin + 100n },
      { bankMessageId: message.id },
      { reviewId: otherReview.id },
    ];
    for (const data of changes) {
      await expectGuard(db.payment.update({ where: { id: payment.id }, data }), 'are immutable');
    }
    const after = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect([after.userId, after.provider, after.amountTiyin, after.reviewId]).toEqual([
      payment.userId,
      payment.provider,
      payment.amountTiyin,
      payment.reviewId,
    ]);
  });

  it('still allows the reversal CONFIRMED -> CANCELLED and the confirmation fields', async () => {
    const f = await p2pFixture();
    const payment = await db.payment.create({
      data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
    });
    const cancelledAt = new Date();
    const reversed = await db.payment.updateMany({
      where: { id: payment.id, status: 'CONFIRMED' },
      data: { status: 'CANCELLED', cancelledAt },
    });
    expect(reversed.count).toBe(1);
    const user = await createUser();
    const other = await reviewPayment(user.id, 2);
    const updated = await db.payment.update({
      where: { id: other.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), raw: { step: 'complete' } },
    });
    expect(updated.status).toBe('CONFIRMED');
  });

  it('writing the same values back is not a change', async () => {
    const user = await createUser();
    const payment = await reviewPayment(user.id, 3);
    await db.payment.update({
      where: { id: payment.id },
      data: { providerTxnId: payment.providerTxnId, amountTiyin: payment.amountTiyin },
    });
  });
});

describe('PaymentReview: bankMessageId and kind are immutable, the resolution is not', () => {
  it('refuses to move a review to another message or kind', async () => {
    const review = await createReview({ kind: 'NO_MATCH' });
    const other = await createBankMessage();
    await expectGuard(
      db.paymentReview.update({ where: { id: review.id }, data: { bankMessageId: other.id } }),
      'bankMessageId and kind are immutable',
    );
    await expectGuard(
      db.paymentReview.update({ where: { id: review.id }, data: { kind: 'TIME_SKEW' } }),
      'bankMessageId and kind are immutable',
    );
  });

  it('allows resolving it: status, resolution, time, audit link, hints, note', async () => {
    const review = await createReview();
    const audit = await createAuditLog();
    const resolved = await db.paymentReview.update({
      where: { id: review.id },
      data: {
        status: 'RESOLVED',
        resolution: 'RETURNED_OFFLINE',
        resolvedAt: new Date(),
        resolvedAuditLogId: audit.id,
        note: 'returned to the sender by hand',
      },
    });
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.kind).toBe(review.kind);
  });
});
