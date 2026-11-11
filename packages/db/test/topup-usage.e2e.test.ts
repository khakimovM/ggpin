import { describe, expect, it } from 'vitest';
import { appendLedgerEntry, usedTopupBaseSince } from '../src/index';
import { db } from './client';
import { createUser } from './factories';
import {
  GRACE_MS,
  HOUR_MS,
  MINUTE_MS,
  createBankMessage,
  createCard,
  createReview,
  p2pIntentData,
  paymentData,
  type PaymentData,
} from './payments-factories';

// D-54: the 24 h top-up caps count money the owner credited from a review WITHOUT an intent
// (review:credit --user), once, at its full amount. One function serves the API and the worker.
const MANUAL = 40_000_000n; // 400 000 so'm
const since = (): Date => new Date(Date.now() - 24 * HOUR_MS);
const used = (userId: string, excludeIntentId?: string): Promise<bigint> =>
  usedTopupBaseSince(db, userId, since(), excludeIntentId);

/** A review credit's Payment: intentless unless `intentId` is given. */
async function reviewPayment(
  userId: string,
  overrides: Partial<PaymentData> = {},
  card?: { id: string; last4: string },
) {
  const amountTiyin = overrides.amountTiyin ?? MANUAL; // the database ties it to the message
  const [review, message] = [
    await createReview(),
    await createBankMessage({
      amountTiyin,
      ...(card === undefined ? {} : { cardId: card.id, last4: card.last4 }),
    }),
  ];
  return db.payment.create({
    data: paymentData(userId, message.id, {
      reviewId: review.id,
      amountTiyin,
      confirmedAt: new Date(),
      ...overrides,
    }),
  });
}

describe('usedTopupBaseSince (D-54: manual credits count)', () => {
  it('an intentless review credit counts at its full amount, next to the intents', async () => {
    const user = await createUser();
    const card = await createCard();
    expect(await used(user.id)).toBe(0n);
    await reviewPayment(user.id);
    expect(await used(user.id)).toBe(MANUAL);
    // A PENDING intent adds its BASE amount on top.
    await db.paymentIntent.create({ data: p2pIntentData(user.id, card.id) });
    expect(await used(user.id)).toBe(MANUAL + 5_000_000n);
  });

  it('a credit WITH an intent is counted once: through the PAID intent, at its base', async () => {
    const user = await createUser();
    const card = await createCard();
    const paidAt = new Date(Date.now() - 5 * MINUTE_MS);
    const intent = await db.paymentIntent.create({
      data: p2pIntentData(user.id, card.id, {
        status: 'PAID',
        paidAt,
        reservedUntil: new Date(paidAt.getTime() + GRACE_MS),
      }),
    });
    await reviewPayment(user.id, { intentId: intent.id, amountTiyin: 5_012_300n }, card);
    expect(await used(user.id)).toBe(5_000_000n);
  });

  it('a reversed credit still counts (like a PAID intent whose top-up was reversed)', async () => {
    const user = await createUser();
    await reviewPayment(user.id, { status: 'CANCELLED', cancelledAt: new Date() });
    expect(await used(user.id)).toBe(MANUAL);
  });

  it('only the window and only this user count; an ADJUSTMENT is not a top-up', async () => {
    const [user, other] = [await createUser(), await createUser()];
    await db.wallet.create({ data: { userId: user.id } });
    await reviewPayment(user.id, { confirmedAt: new Date(Date.now() - 25 * HOUR_MS) });
    await reviewPayment(other.id);
    await db.$transaction((tx) =>
      appendLedgerEntry(tx, {
        userId: user.id,
        kind: 'ADJUSTMENT',
        amountTiyin: 90_000_000n,
        refType: 'ADMIN_ACTION',
        refId: 'adjust-1',
      }),
    );
    expect(await used(user.id)).toBe(0n);
    expect(await used(other.id)).toBe(MANUAL);
  });

  it('excludeIntentId leaves the credited intent out, the manual money stays in', async () => {
    const user = await createUser();
    const card = await createCard();
    const intent = await db.paymentIntent.create({ data: p2pIntentData(user.id, card.id) });
    await reviewPayment(user.id);
    expect(await used(user.id, intent.id)).toBe(MANUAL);
  });
});
