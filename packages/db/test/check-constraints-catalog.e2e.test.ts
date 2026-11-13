import { describe, expect, it } from 'vitest';
import { expectCheck } from './check-helpers';
import { db } from './client';
import { createOrder, createUser } from './factories';
import { walkTo } from './order-fixtures';

const createAdmin = () =>
  db.adminUser.create({ data: { telegramId: 42n, name: 'a', role: 'OWNER' } });

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

  it('BonusCode: usage counters stay within 0..maxUses and maxUses is positive', async () => {
    const admin = await createAdmin();
    const code = {
      codeHash: 'h1',
      rewardType: 'COINS',
      rewardCoins: 5n,
      maxUses: 2,
      createdById: admin.id,
    };
    const created = await db.bonusCode.create({ data: { ...code, usedCount: 2 } });
    await expectCheck(
      db.bonusCode.update({ where: { id: created.id }, data: { usedCount: 3 } }),
      'BonusCode_usage_check',
    );
    await expectCheck(
      db.bonusCode.update({ where: { id: created.id }, data: { usedCount: -1 } }),
      'BonusCode_usage_check',
    );
    await expectCheck(
      db.bonusCode.create({ data: { ...code, codeHash: 'h3', maxUses: 0 } }),
      'BonusCode_usage_check',
    );
  });

  it('BonusCode: exactly one reward column, matching rewardType and strictly positive', async () => {
    const admin = await createAdmin();
    const base = { maxUses: 1, createdById: admin.id };
    let n = 0;
    const make = (data: {
      rewardType: string;
      rewardTiyin?: bigint | null;
      rewardCoins?: bigint | null;
    }) => db.bonusCode.create({ data: { ...base, codeHash: `r${String(n++)}`, ...data } });

    // one valid row of each type
    await make({ rewardType: 'WALLET_TIYIN', rewardTiyin: 1n });
    await make({ rewardType: 'COINS', rewardCoins: 1n });

    const rejected = [
      { rewardType: 'WALLET_TIYIN', rewardTiyin: 100n, rewardCoins: 5n }, // both set
      { rewardType: 'COINS', rewardTiyin: 100n, rewardCoins: 5n }, // both set
      { rewardType: 'WALLET_TIYIN' }, // neither set
      { rewardType: 'COINS' }, // neither set
      { rewardType: 'WALLET_TIYIN', rewardCoins: 5n }, // type mismatch
      { rewardType: 'COINS', rewardTiyin: 100n }, // type mismatch
      { rewardType: 'WALLET_TIYIN', rewardTiyin: 0n },
      { rewardType: 'WALLET_TIYIN', rewardTiyin: -1n },
      { rewardType: 'COINS', rewardCoins: 0n },
      { rewardType: 'COINS', rewardCoins: -1n },
      { rewardType: 'WALLET_TIYIN', rewardTiyin: 100n, rewardCoins: 0n }, // zero is not NULL
      { rewardType: 'OTHER', rewardTiyin: 100n }, // unknown type
    ];
    for (const data of rejected) {
      await expectCheck(make(data), 'BonusCode_reward_check');
    }
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
        data: { network: 'testnet', address: 'a', nanoTon: -1n, microUsdt: 0n },
      }),
      'WalletSnapshot_balances_check',
    );
    await expectCheck(
      db.walletSnapshot.create({
        data: { network: 'testnet', address: 'a', nanoTon: 0n, microUsdt: -1n },
      }),
      'WalletSnapshot_balances_check',
    );
    await db.walletSnapshot.create({
      data: { network: 'testnet', address: 'a', nanoTon: 0n, microUsdt: 0n },
    });
  });

  it('D-30.2 renames: old columns are gone and the CHECKs reference the new names', async () => {
    const columns = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('WalletSnapshot', 'BonusCode')`;
    const names = columns.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'WalletSnapshot.nanoTon',
        'WalletSnapshot.microUsdt',
        'BonusCode.rewardTiyin',
        'BonusCode.rewardCoins',
      ]),
    );
    for (const old of [
      'WalletSnapshot.tonNano',
      'WalletSnapshot.usdtMicro',
      'BonusCode.rewardValue',
    ]) {
      expect(names).not.toContain(old);
    }
    const defs = await db.$queryRaw<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('WalletSnapshot_balances_check', 'BonusCode_usage_check')`;
    const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
    expect(byName['WalletSnapshot_balances_check']).toContain('nanoTon');
    expect(byName['WalletSnapshot_balances_check']).toContain('microUsdt');
    expect(byName['BonusCode_usage_check']).not.toContain('rewardValue');
  });

  it('FulfillmentAttempt: attemptNo >= 1 and non-negative cost', async () => {
    const order = await createOrder(await createUser());
    await walkTo(order.id, 'PROCESSING'); // a payout starts for a PROCESSING order only
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
