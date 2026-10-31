import { describe, expect, it } from 'vitest';
import type { CoinKind, LedgerKind } from '../src/index';
import { db } from './client';
import { createIntent, createOrder, createQuote, createUser } from './factories';

// CHECK violations are Postgres 23514; the driver message names the constraint.
async function expectCheck(promise: Promise<unknown>, constraint: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `${constraint} must reject`).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(constraint);
}

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

  it('Order discount must be within 0..price', async () => {
    const { order } = await orderData();
    await db.order.update({ where: { id: order.id }, data: { discountTiyin: order.priceTiyin } });
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

describe('catalog, promo and misc families', () => {
  it('Sku: quantity > 0, margin and markup >= 0', async () => {
    const order = await createOrder(await createUser());
    const base = { productId: order.productId, labelUz: 'a', labelRu: 'b' };
    await db.sku.create({ data: { ...base, quantity: 60, markupBps: 1500 } });
    await expectCheck(
      db.sku.create({ data: { ...base, quantity: 0, markupBps: 1 } }),
      'Sku_amounts_check',
    );
    await expectCheck(
      db.sku.create({ data: { ...base, quantity: 1, markupBps: -1 } }),
      'Sku_amounts_check',
    );
    await expectCheck(
      db.sku.create({ data: { ...base, quantity: 1, markupBps: 1, minMarginTiyin: -1n } }),
      'Sku_amounts_check',
    );
  });

  it('Product: minQty/maxQty positive and ordered', async () => {
    const order = await createOrder(await createUser());
    for (const bad of [{ minQty: 0 }, { maxQty: 0 }, { minQty: 10, maxQty: 5 }]) {
      await expectCheck(
        db.product.update({ where: { id: order.productId }, data: bad }),
        'Product_qty_check',
      );
    }
    await db.product.update({ where: { id: order.productId }, data: { minQty: 5, maxQty: 5 } });
  });

  it('BonusCode: usedCount <= maxUses and positive reward', async () => {
    const admin = await db.adminUser.create({
      data: { telegramId: 42n, name: 'a', role: 'OWNER' },
    });
    const code = {
      codeHash: 'h1',
      rewardType: 'COINS',
      rewardValue: 5n,
      maxUses: 2,
      createdById: admin.id,
    };
    const created = await db.bonusCode.create({ data: { ...code, usedCount: 2 } });
    await expectCheck(
      db.bonusCode.update({ where: { id: created.id }, data: { usedCount: 3 } }),
      'BonusCode_usage_check',
    );
    await expectCheck(
      db.bonusCode.create({ data: { ...code, codeHash: 'h2', rewardValue: 0n } }),
      'BonusCode_usage_check',
    );
    await expectCheck(
      db.bonusCode.create({ data: { ...code, codeHash: 'h3', maxUses: 0 } }),
      'BonusCode_usage_check',
    );
  });

  it('basis points stay within 0..10000 (DiscountTier, DiscountCode)', async () => {
    const user = await createUser();
    const tier = await db.discountTier.create({ data: { bps: 10_000, priceCoins: 1n } });
    await expectCheck(
      db.discountTier.create({ data: { bps: 10_001, priceCoins: 1n } }),
      'DiscountTier_values_check',
    );
    await expectCheck(
      db.discountTier.create({ data: { bps: -1, priceCoins: 1n } }),
      'DiscountTier_values_check',
    );
    await expectCheck(
      db.discountTier.create({ data: { bps: 5, priceCoins: 0n } }),
      'DiscountTier_values_check',
    );
    const code = { userId: user.id, tierId: tier.id };
    await expectCheck(
      db.discountCode.create({ data: { ...code, bps: 10_001, code: 'c1' } }),
      'DiscountCode_bps_check',
    );
    await expectCheck(
      db.discountCode.create({ data: { ...code, bps: -1, code: 'c2' } }),
      'DiscountCode_bps_check',
    );
  });

  it('FxRate.rate must be a strictly positive decimal with at most 18 places', async () => {
    await db.fxRate.create({ data: { pair: 'USDT_UZS', rate: '12600.5', source: 't' } });
    for (const rate of ['0', '0.000', '-1', '1e3', '', '1,5', '.5', '1.1234567890123456789']) {
      await expectCheck(
        db.fxRate.create({ data: { pair: 'USDT_UZS', rate, source: 't' } }),
        'FxRate_rate_check',
      );
    }
  });

  it('User cannot refer themselves', async () => {
    const user = await createUser();
    await expectCheck(
      db.user.update({ where: { id: user.id }, data: { referredById: user.id } }),
      'User_no_self_referral_check',
    );
    const other = await createUser();
    await db.user.update({ where: { id: user.id }, data: { referredById: other.id } });
  });

  it('Voucher cost and WalletSnapshot balances cannot be negative', async () => {
    const order = await createOrder(await createUser());
    const sku = await db.sku.create({
      data: { productId: order.productId, labelUz: 'a', labelRu: 'b', quantity: 1, markupBps: 0 },
    });
    await expectCheck(
      db.voucher.create({
        data: { skuId: sku.id, codeEnc: 'x', codeHash: 'vh', costMicroUsdt: 0n },
      }),
      'Voucher_cost_check',
    );
    await expectCheck(
      db.walletSnapshot.create({
        data: { network: 'testnet', address: 'a', tonNano: -1n, usdtMicro: 0n },
      }),
      'WalletSnapshot_balances_check',
    );
  });

  it('FulfillmentAttempt: attemptNo >= 1 and non-negative cost', async () => {
    const order = await createOrder(await createUser());
    const base = {
      orderId: order.id,
      adapter: 'FRAGMENT',
      status: 'SENDING',
      request: {},
    } as const;
    await expectCheck(
      db.fulfillmentAttempt.create({ data: { ...base, attemptNo: 0 } }),
      'FulfillmentAttempt_values_check',
    );
    await expectCheck(
      db.fulfillmentAttempt.create({ data: { ...base, attemptNo: 1, costMinor: -1n } }),
      'FulfillmentAttempt_values_check',
    );
  });
});
