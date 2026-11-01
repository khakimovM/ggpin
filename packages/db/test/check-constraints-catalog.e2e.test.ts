import { describe, it } from 'vitest';
import { expectCheck } from './check-helpers';
import { db } from './client';
import { createOrder, createUser } from './factories';

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

  it('basis points stay within 0..9999: 10000 (100%) would zero the PURCHASE amount', async () => {
    const user = await createUser();
    const tier = await db.discountTier.create({ data: { bps: 9_999, priceCoins: 1n } });
    await db.discountTier.create({ data: { bps: 0, priceCoins: 1n } });
    for (const bps of [10_000, 10_001]) {
      await expectCheck(
        db.discountTier.create({ data: { bps, priceCoins: 1n } }),
        'DiscountTier_values_check',
      );
    }
    await expectCheck(
      db.discountTier.create({ data: { bps: -1, priceCoins: 1n } }),
      'DiscountTier_values_check',
    );
    await expectCheck(
      db.discountTier.create({ data: { bps: 5, priceCoins: 0n } }),
      'DiscountTier_values_check',
    );
    const code = { userId: user.id, tierId: tier.id };
    await db.discountCode.create({ data: { ...code, bps: 9_999, code: 'ok' } });
    for (const bps of [10_000, 10_001]) {
      await expectCheck(
        db.discountCode.create({ data: { ...code, bps, code: `c${String(bps)}` } }),
        'DiscountCode_bps_check',
      );
    }
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
