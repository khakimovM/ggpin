import { describe, it } from 'vitest';
import type { CoinKind, LedgerKind } from '../src/index';
import { expectCheck } from './check-helpers';
import { db } from './client';
import { createIntent, createOrder, createQuote, createUser } from './factories';
import { bypassingGuards } from './order-fixtures';

let ref = 0;
const ledger = (userId: string, kind: LedgerKind, amountTiyin: bigint) =>
  db.ledgerEntry.create({
    data: { userId, kind, amountTiyin, refType: 'TEST', refId: `r${++ref}` },
  });
// The sign CHECK is what is under test. A PURCHASE that the CHECK accepts would still be refused at
// COMMIT without its order (D-60, order-purchase-ledger-check.e2e.test.ts), so the accepted one is
// written with the triggers off: CHECK constraints are not triggers and stay on.
const accepted = (userId: string, kind: LedgerKind, amountTiyin: bigint) =>
  kind === 'PURCHASE'
    ? bypassingGuards((tx) =>
        tx.ledgerEntry.create({
          data: { userId, kind, amountTiyin, refType: 'TEST', refId: `r${++ref}` },
        }),
      )
    : ledger(userId, kind, amountTiyin);
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
    await accepted(id, kind, -1n);
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

// Since phase 5 the purchase columns of Order and Quote are immutable (GG001 triggers), so these
// CHECKs are exercised on INSERT: the same constraints, the same bad values, a new row each time.
// The triggers have their own matrix in check-constraints-orders.e2e.test.ts.
describe('order and quote amounts', () => {
  const PRICE = 5_000_000n; // the factory's priceTiyin
  const COST = 1_000_000_000n; // the factory's costMinor

  it('Order rejects zero quantity, non-positive price/cost and maxCost below cost', async () => {
    const user = await createUser();
    for (const bad of [
      { quantity: 0 },
      { priceTiyin: 0n },
      { costMinor: 0n },
      { costMinor: 10n, maxCostMinor: 9n },
    ]) {
      // Unguarded: an order that differs from its quote is refused by the order guard first (Z4).
      await expectCheck(
        createOrder(user, undefined, bad, { unguarded: true }),
        'Order_amounts_check',
      );
    }
  });

  it('Order discount must be below the price: a 100% discount cannot write its PURCHASE entry', async () => {
    const user = await createUser();
    await createOrder(user, undefined, { discountTiyin: PRICE - 1n });
    for (const discountTiyin of [PRICE, PRICE + 1n, -1n]) {
      await expectCheck(createOrder(user, undefined, { discountTiyin }), 'Order_discount_check');
    }
  });

  it('Quote rejects zero quantity, non-positive price and maxCost below cost', async () => {
    const user = await createUser();
    for (const bad of [
      { quantity: 0 },
      { priceTiyin: 0n },
      { costMinor: 0n },
      { maxCostMinor: COST - 1n },
    ]) {
      await expectCheck(createQuote(user.id, bad), 'Quote_amounts_check');
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
          userId: user.id,
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
