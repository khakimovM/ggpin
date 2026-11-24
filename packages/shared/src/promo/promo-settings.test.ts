import { describe, expect, it } from 'vitest';
import {
  ACTIVE_DISCOUNT_CODES_MAX,
  DISCOUNT_TIERS_DEFAULT,
  PROMO_RATE_MAX_BPS,
  PROMO_SETTING_KEYS,
  PROMO_SETTINGS_DEFAULT,
  PROMO_TOTAL_MAX_BPS,
  PromoSettingsSchema,
  parsePromoSettings,
  withinPromoBudget,
} from './promo-settings';

const stored = {
  referralBps: 100,
  cashbackBps: 50,
  coinUnitTiyin: '10000',
  referralDailyCapTiyin: '10000000',
};

describe('promo settings (D-72 (3), (4), (10))', () => {
  it('the D-72 defaults: 1%, 0.5%, 1 coin = 100 so‘m, 100 000 so‘m a day', () => {
    expect(PROMO_SETTINGS_DEFAULT).toEqual({
      referralBps: 100,
      cashbackBps: 50,
      coinUnitTiyin: 10_000n,
      referralDailyCapTiyin: 10_000_000n,
    });
    expect(parsePromoSettings(stored)).toEqual(PROMO_SETTINGS_DEFAULT);
  });

  it('the Setting keys are the ones schema.prisma names', () => {
    expect(Object.values(PROMO_SETTING_KEYS)).toEqual([
      'REFERRAL_BPS',
      'CASHBACK_BPS',
      'COIN_UNIT_TIYIN',
      'REFERRAL_DAILY_CAP_TIYIN',
    ]);
  });

  it('accepts each rate up to 3% and refuses above', () => {
    expect(PROMO_RATE_MAX_BPS).toBe(300);
    expect(parsePromoSettings({ ...stored, referralBps: 300, cashbackBps: 0 })).not.toBeNull();
    expect(parsePromoSettings({ ...stored, referralBps: 301 })).toBeNull();
    expect(parsePromoSettings({ ...stored, cashbackBps: 301 })).toBeNull();
    expect(parsePromoSettings({ ...stored, cashbackBps: -1 })).toBeNull();
    expect(parsePromoSettings({ ...stored, referralBps: 1.5 })).toBeNull();
  });

  it('a broken stored value is never fixed up: it is no settings at all', () => {
    expect(parsePromoSettings({ ...stored, coinUnitTiyin: '0' })).toBeNull();
    expect(parsePromoSettings({ ...stored, referralDailyCapTiyin: '0' })).toBeNull();
    expect(parsePromoSettings({ ...stored, coinUnitTiyin: 10000 })).toBeNull(); // money is a string
    expect(parsePromoSettings({ ...stored, referralDailyCapTiyin: '1.5' })).toBeNull();
    expect(parsePromoSettings({ ...stored, extra: 1 })).toBeNull();
    const { cashbackBps: _dropped, ...missing } = stored;
    expect(parsePromoSettings(missing)).toBeNull();
    expect(parsePromoSettings(null)).toBeNull();
    expect(parsePromoSettings('100')).toBeNull();
    expect(PromoSettingsSchema.safeParse(stored).success).toBe(true);
  });

  it('the budget: referral + cashback + biggest tier at most 5%', () => {
    expect(PROMO_TOTAL_MAX_BPS).toBe(500);
    expect(withinPromoBudget(PROMO_SETTINGS_DEFAULT, 150)).toBe(true);
    const max = { ...PROMO_SETTINGS_DEFAULT, referralBps: 300, cashbackBps: 200 };
    expect(withinPromoBudget(max, 0)).toBe(true);
    expect(withinPromoBudget(max, 1)).toBe(false);
    expect(withinPromoBudget(PROMO_SETTINGS_DEFAULT, 350)).toBe(true);
    expect(withinPromoBudget(PROMO_SETTINGS_DEFAULT, 351)).toBe(false);
    expect(withinPromoBudget(PROMO_SETTINGS_DEFAULT, -1)).toBe(false);
    expect(withinPromoBudget(PROMO_SETTINGS_DEFAULT, 1.5)).toBe(false);
  });
});

describe('discount tiers (D-72 (5))', () => {
  it('the designed four tiers with their caps, 30 days each', () => {
    expect(DISCOUNT_TIERS_DEFAULT).toEqual([
      { bps: 20, priceCoins: 15n, maxDiscountTiyin: 200_000n, validDays: 30 },
      { bps: 50, priceCoins: 35n, maxDiscountTiyin: 500_000n, validDays: 30 },
      { bps: 100, priceCoins: 70n, maxDiscountTiyin: 1_000_000n, validDays: 30 },
      { bps: 150, priceCoins: 90n, maxDiscountTiyin: 1_500_000n, validDays: 30 },
    ]);
    expect(ACTIVE_DISCOUNT_CODES_MAX).toBe(5);
  });

  it('the default rates and the biggest default tier fit the budget', () => {
    const biggest = Math.max(...DISCOUNT_TIERS_DEFAULT.map((tier) => tier.bps));
    expect(withinPromoBudget(PROMO_SETTINGS_DEFAULT, biggest)).toBe(true);
  });
});
