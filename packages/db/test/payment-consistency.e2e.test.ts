import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { createUser } from './factories';
import {
  createBankMessage,
  createCard,
  createReview,
  p2pFixture,
  p2pIntentData,
  paymentData,
} from './payments-factories';

function createClickIntent(userId: string, key: string) {
  return db.paymentIntent.create({
    data: {
      userId,
      provider: 'CLICK',
      amountTiyin: 5_012_300n,
      purpose: 'TOPUP',
      idempotencyKey: key,
      requestHash: 'h',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

describe('Payment checks and uniques', () => {
  it('Payment_source_check: needs an intent or a review', async () => {
    const f = await p2pFixture();
    const review = await createReview();
    const [m2, m3] = [await createBankMessage(), await createBankMessage()];
    await db.payment.create({
      data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
    });
    await db.payment.create({ data: paymentData(f.userId, m2.id, { reviewId: review.id }) });
    await expectCheck(
      db.payment.create({ data: paymentData(f.userId, m3.id) }),
      'Payment_source_check',
    );
  });

  it('Payment_p2p_check: a P2P_CARD payment must name its bank message; others need not', async () => {
    const f = await p2pFixture();
    await expectCheck(
      db.payment.create({
        data: paymentData(f.userId, f.messageId, { intentId: f.intentId, bankMessageId: null }),
      }),
      'Payment_p2p_check',
    );
    const clickIntent = await createClickIntent(f.userId, 'click-p2p-check');
    await db.payment.create({
      data: paymentData(f.userId, f.messageId, {
        intentId: clickIntent.id,
        bankMessageId: null,
        provider: 'CLICK',
        providerTxnId: 'click-1',
      }),
    });
  });

  it('one payment per bank message and per review; the user must exist', async () => {
    const f = await p2pFixture();
    const review = await createReview();
    const [m2, m3] = [await createBankMessage(), await createBankMessage()];
    await db.payment.create({
      data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
    });
    await expectPrismaCode(
      db.payment.create({
        data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
      }),
      'P2002',
    );
    await db.payment.create({ data: paymentData(f.userId, m2.id, { reviewId: review.id }) });
    await expectPrismaCode(
      db.payment.create({ data: paymentData(f.userId, m3.id, { reviewId: review.id }) }),
      'P2002',
    );
    const other = await createReview();
    await expectPrismaCode(
      db.payment.create({
        data: paymentData('missing-user', m3.id, { reviewId: other.id }),
      }),
      'P2003',
    );
  });

  it('two parallel payments for one bank message: exactly one is stored', async () => {
    const f = await p2pFixture();
    const attempt = () =>
      db.payment.create({
        data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
      });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as { code?: unknown }).code).toBe('P2002');
    }
    expect(await db.payment.count()).toBe(1);
  });
});

describe('Payment consistency guard (trigger, GG004)', () => {
  const GG004 = 'GG004';

  it('a payment of an intent belongs to the intent owner', async () => {
    const f = await p2pFixture();
    const stranger = await createUser();
    await expectGuard(
      db.payment.create({
        data: paymentData(stranger.id, f.messageId, { intentId: f.intentId }),
      }),
      'not the owner',
      GG004,
    );
    await db.payment.create({
      data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
    });
  });

  it('the owner rule also holds for other providers and for updates', async () => {
    const f = await p2pFixture();
    const stranger = await createUser();
    const intent = await db.paymentIntent.create({
      data: p2pIntentData(stranger.id, f.cardId, { amountTiyin: 5_023_400n }),
    });
    await expectGuard(
      db.payment.create({
        data: paymentData(f.userId, f.messageId, {
          provider: 'CLICK',
          bankMessageId: null,
          intentId: intent.id,
        }),
      }),
      'not the owner',
      GG004,
    );
    const payment = await db.payment.create({
      data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
    });
    await expectGuard(
      db.payment.update({ where: { id: payment.id }, data: { intentId: intent.id } }),
      'not the owner',
      GG004,
    );
  });

  it('a P2P payment is a PARSED CREDIT message for exactly its amount', async () => {
    const f = await p2pFixture();
    const wrongAmount = await createBankMessage({ amountTiyin: 5_012_400n });
    const debit = await createBankMessage({ direction: 'DEBIT' });
    const unparsed = await createBankMessage({
      parseStatus: 'REJECTED',
      rejectReason: 'EDITED',
      direction: null,
      amountTiyin: null,
      balanceAfterTiyin: null,
      last4: null,
      bankTxnAt: null,
    });
    for (const m of [wrongAmount, debit, unparsed]) {
      await expectGuard(
        db.payment.create({ data: paymentData(f.userId, m.id, { intentId: f.intentId }) }),
        'PARSED CREDIT',
        GG004,
      );
    }
    const payment = await db.payment.create({
      data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
    });
    await expectGuard(
      db.payment.update({ where: { id: payment.id }, data: { amountTiyin: 5_012_400n } }),
      'PARSED CREDIT',
      GG004,
    );
  });

  it('an intent payment must come from a message for the intent card and amount', async () => {
    const f = await p2pFixture();
    const otherCard = await createCard();
    const onOtherCard = await createBankMessage({ cardId: otherCard.id, last4: otherCard.last4 });
    const withoutCard = await createBankMessage();
    const otherAmount = await createBankMessage({
      cardId: f.cardId,
      last4: f.cardLast4,
      amountTiyin: 5_012_400n,
    });
    const cases = [
      { message: onOtherCard.id, amountTiyin: 5_012_300n }, // right amount, wrong card
      { message: withoutCard.id, amountTiyin: 5_012_300n }, // no card on the message at all
      { message: otherAmount.id, amountTiyin: 5_012_400n }, // right card, wrong amount
    ];
    for (const c of cases) {
      await expectGuard(
        db.payment.create({
          data: paymentData(f.userId, c.message, {
            intentId: f.intentId,
            amountTiyin: c.amountTiyin,
          }),
        }),
        'intent card and amount',
        GG004,
      );
    }
    // The same transfer is still creditable to the user without the intent (review:credit --user).
    const review = await createReview({ bankMessageId: onOtherCard.id });
    await db.payment.create({
      data: paymentData(f.userId, onOtherCard.id, { reviewId: review.id }),
    });
  });

  it('a payment has the provider of its intent, both ways (Y3)', async () => {
    const f = await p2pFixture();
    const clickIntent = await createClickIntent(f.userId, 'click-y3');
    await expectGuard(
      db.payment.create({
        data: paymentData(f.userId, f.messageId, { intentId: clickIntent.id }),
      }),
      'differs from the provider',
      GG004,
    );
    await expectGuard(
      db.payment.create({
        data: paymentData(f.userId, f.messageId, {
          intentId: f.intentId,
          provider: 'CLICK',
          bankMessageId: null,
          providerTxnId: 'click-y3-txn',
        }),
      }),
      'differs from the provider',
      GG004,
    );
    await db.payment.create({
      data: paymentData(f.userId, f.messageId, {
        intentId: clickIntent.id,
        provider: 'CLICK',
        bankMessageId: null,
        providerTxnId: 'click-y3-ok',
      }),
    });
  });

  it('an intent that does not exist is left to the foreign key (FOUND is false)', async () => {
    const f = await p2pFixture();
    await expectPrismaCode(
      db.payment.create({
        data: paymentData(f.userId, f.messageId, { intentId: 'no-such-intent' }),
      }),
      'P2003',
    );
  });

  it('leaves a message that does not exist to the foreign key', async () => {
    const f = await p2pFixture();
    await expectPrismaCode(
      db.payment.create({
        data: paymentData(f.userId, 'no-such-message', { intentId: f.intentId }),
      }),
      'P2003',
    );
  });
});

describe('migration 20261104130000_p4_wallet_p2p: Payment guard', () => {
  // The guard is the DO block at the top of the migration. It runs before "Payment"."userId"
  // NOT NULL is added; with data in the table it must stop instead of guessing owners.
  const sql = readFileSync(
    new URL('../prisma/migrations/20261104130000_p4_wallet_p2p/migration.sql', import.meta.url),
    'utf8',
  );
  const guard = /^DO \$\$[\s\S]*?^\$\$;/m.exec(sql)?.[0] ?? '';

  it('is present in the migration', () => {
    expect(guard).toContain('RAISE EXCEPTION');
  });

  it('passes on an empty Payment table', async () => {
    await db.$executeRawUnsafe(guard);
  });

  it('raises GG002 when Payment has a row', async () => {
    const f = await p2pFixture();
    await db.payment.create({
      data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
    });
    await expectGuard(db.$executeRawUnsafe(guard), 'Payment is not empty', 'GG002');
  });
});
