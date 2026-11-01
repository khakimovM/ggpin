import { describe, it } from 'vitest';
import type { CoinKind, LedgerKind } from '../src/index';
import { expectCheck } from './check-helpers';
import { db } from './client';
import { createIntent, createOrder, createQuote, createUser } from './factories';

let ref = 0;
const ledger = (userId: string, kind: LedgerKind, amountTiyin: bigint) =>
  db.ledgerEntry.create({
    data: { userId, kind, amountTiyin, refType: 'TEST', refId: `r${++ref}` },
  });
const coins = (userId: string, kind: CoinKind, amount: bigint) =>
  db.coinEntry.create({
    data: { userId, kind, coins: amount, refType: 'TEST', refId: `c${++ref}` },
  });

describe('LedgerEntry sign per kind', () => {
  const POSITIVE: LedgerKind[] = ['TOPUP', 'REFUND', 'REFERRAL_BONUS'];
  const NEGATIVE: LedgerKind[] = ['TOPUP_REVERSAL', 'PURCHASE', 'REFERRAL_BONUS_REVERSAL'];

  it.each(POSITIVE)('%s accepts + and rejects - and 0', async (kind) => {
    const { id } = await createUser();
    await ledger(id, kind, 1n);
    await expectCheck(ledger(id, kind, -1n), 'LedgerEntry_amount_sign_check');
    await expectCheck(ledger(id, kind, 0n), 'LedgerEntry_amount_sign_check');
  });

  it.each(NEGATIVE)('%s accepts - and rejects + and 0', async (kind) => {
    const { id } = await createUser();
    await ledger(id, kind, -1n);
    await expectCheck(ledger(id, kind, 1n), 'LedgerEntry_amount_sign_check');
    await expectCheck(ledger(id, kind, 0n), 'LedgerEntry_amount_sign_check');
  });

  it('ADJUSTMENT accepts either sign but not zero', async () => {
    const { id } = await createUser();
    await ledger(id, 'ADJUSTMENT', 5n);
    await ledger(id, 'ADJUSTMENT', -5n);
    await expectCheck(ledger(id, 'ADJUSTMENT', 0n), 'LedgerEntry_amount_sign_check');
  });
});

describe('CoinEntry sign per kind', () => {
  it('EARN > 0; SPEND and EXPIRE < 0; ADJUSTMENT and REVERSAL <> 0', async () => {
    const { id } = await createUser();
    await coins(id, 'EARN', 1n);
    await coins(id, 'SPEND', -1n);
    await coins(id, 'EXPIRE', -1n);
    await coins(id, 'ADJUSTMENT', -3n);
    await coins(id, 'REVERSAL', -1n);
    for (const [kind, bad] of [
      ['EARN', -1n],
      ['EARN', 0n],
      ['SPEND', 1n],
      ['EXPIRE', 0n],
      ['ADJUSTMENT', 0n],
      ['REVERSAL', 0n],
    ] as const) {
      await expectCheck(coins(id, kind, bad), 'CoinEntry_coins_sign_check');
    }
  });
});

describe('order and quote amounts', () => {
  const orderData = async () => {
    const order = await createOrder(await createUser());
    return { order, quote: await createQuote(order.userId) };
  };

  it('Order rejects zero quantity, non-positive price/cost and maxCost below cost', async () => {
    const { order } = await orderData();
    for (const bad of [
      { quantity: 0 },
      { priceTiyin: 0n },
      { costMinor: 0n },
      { costMinor: 10n, maxCostMinor: 9n },
    ]) {
      await expectCheck(
        db.order.update({ where: { id: order.id }, data: bad }),
        'Order_amounts_check',
      );
    }
  });

  it('Order discount must be below the price: a 100% discount cannot write its PURCHASE entry', async () => {
    const { order } = await orderData();
    await db.order.update({
      where: { id: order.id },
      data: { discountTiyin: order.priceTiyin - 1n },
    });
    await expectCheck(
      db.order.update({ where: { id: order.id }, data: { discountTiyin: order.priceTiyin } }),
      'Order_discount_check',
    );
    await expectCheck(
      db.order.update({ where: { id: order.id }, data: { discountTiyin: order.priceTiyin + 1n } }),
      'Order_discount_check',
    );
    await expectCheck(
      db.order.update({ where: { id: order.id }, data: { discountTiyin: -1n } }),
      'Order_discount_check',
    );
  });

  it('Quote rejects zero quantity, non-positive price and maxCost below cost', async () => {
    const { quote } = await orderData();
    for (const bad of [
      { quantity: 0 },
      { priceTiyin: 0n },
      { costMinor: 0n },
      { maxCostMinor: quote.costMinor - 1n },
    ]) {
      await expectCheck(
        db.quote.update({ where: { id: quote.id }, data: bad }),
        'Quote_amounts_check',
      );
    }
  });

  it('PaymentIntent and Payment reject non-positive amounts', async () => {
    const user = await createUser();
    await expectCheck(
      db.paymentIntent.create({
        data: {
          userId: user.id,
          provider: 'CLICK',
          amountTiyin: 0n,
          purpose: 'TOPUP',
          idempotencyKey: 'k0',
          requestHash: 'h',
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
      'PaymentIntent_amount_check',
    );
    const intent = await createIntent(user.id);
    await expectCheck(
      db.payment.create({
        data: {
          intentId: intent.id,
          provider: 'CLICK',
          providerTxnId: 't0',
          amountTiyin: -1n,
          status: 'CREATED',
          raw: {},
        },
      }),
      'Payment_amount_check',
    );
  });
});
