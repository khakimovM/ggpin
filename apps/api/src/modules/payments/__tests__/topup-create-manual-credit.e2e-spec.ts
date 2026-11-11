import { randomBytes } from 'node:crypto';
import { createBody, usePaymentsE2e } from './payments-e2e.helpers';

// D-54: money the owner credited from a review without an intent (review:credit --user) counts
// against the 24 h daily cap when the user asks for the next top-up (code-review-api L-1).
const e2e = usePaymentsE2e();

/** The Payment row review:credit --user leaves: its review, its bank message, no intent. */
async function manualCredit(userId: string, amountTiyin: bigint): Promise<void> {
  const db = e2e.db();
  const tag = randomBytes(6).toString('hex');
  const message = await db.bankMessage.create({
    data: {
      source: 'HUMO_BOT',
      senderId: 777_000_000_000n,
      tgMessageId: BigInt(`0x${tag}`),
      tgDate: new Date(Date.now() - 60_000),
      textSha256: randomBytes(32).toString('hex'),
      parseStatus: 'PARSED',
      parserVersion: 1,
      direction: 'CREDIT',
      amountTiyin,
      balanceAfterTiyin: amountTiyin + 7n,
      last4: '0000',
      bankTxnAt: new Date(Date.now() - 60_000),
    },
  });
  const review = await db.paymentReview.create({
    data: { bankMessageId: message.id, kind: 'NO_MATCH' },
  });
  await db.payment.create({
    data: {
      userId,
      provider: 'P2P_CARD',
      providerTxnId: `${message.senderId.toString()}:${message.tgMessageId.toString()}`,
      amountTiyin,
      status: 'CONFIRMED',
      raw: { via: 'REVIEW' },
      bankMessageId: message.id,
      reviewId: review.id,
      confirmedAt: new Date(),
    },
  });
}

describe('POST /payments/intents after a manual (intentless) credit', () => {
  it('new account: 400 000 so‘m credited by hand leaves 100 000 so‘m of the 500 000 cap; 200 000 is 422 with max', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    await manualCredit(user.id, 40_000_000n);
    const res = await e2e.create(user, createBody(20_000_000n));
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual(
      expect.objectContaining({
        code: 'TOPUP_AMOUNT_OUT_OF_RANGE',
        details: {
          min: '500000',
          max: '10000000',
          step: '100000',
          reason: 'NEW_ACCOUNT_DAILY_LIMIT',
        },
      }),
    );
    // What is left is still available.
    expect((await e2e.create(user, createBody(10_000_000n))).status).toBe(201);
  });
});
