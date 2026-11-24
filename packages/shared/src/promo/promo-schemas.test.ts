import { describe, expect, it } from 'vitest';
import { CreateQuoteBodySchema } from '../pricing/quote-schemas';
import {
  BonusRedeemResponseSchema,
  CreateDiscountCodeBodySchema,
  DiscountCodeItemSchema,
  DiscountCodesQuerySchema,
  DiscountTiersResponseSchema,
  QuoteDiscountCodeSchema,
  RedeemBonusCodeBodySchema,
  ReferralsQuerySchema,
  ReferralsResponseSchema,
} from './promo-schemas';

const ID = 'cm3tier00000000000000001';
const referrals = {
  link: 'https://t.me/ggpin_bot?start=ref_ab12cd34',
  miniAppLink: 'https://t.me/ggpin_bot?startapp=ref_ab12cd34',
  invitedCount: 2,
  earnedTiyin: '25000',
  rateBps: 100,
  invited: [
    {
      displayName: 'Sardor',
      usernameMasked: '@sa***',
      joinedAt: '2026-11-20T08:00:00.000Z',
      earnedTiyin: '25000',
    },
    {
      displayName: null,
      usernameMasked: null,
      joinedAt: '2026-11-21T08:00:00.000Z',
      earnedTiyin: '0',
    },
  ],
};

describe('GET /referrals', () => {
  it('the contract example parses', () => {
    expect(ReferralsResponseSchema.parse(referrals)).toEqual(referrals);
  });

  it('no extra keys (no Telegram id, no phone) and no negative money', () => {
    const leaky = { ...referrals.invited[0], telegramId: '123' };
    expect(ReferralsResponseSchema.safeParse({ ...referrals, invited: [leaky] }).success).toBe(
      false,
    );
    expect(ReferralsResponseSchema.safeParse({ ...referrals, earnedTiyin: '-1' }).success).toBe(
      false,
    );
    expect(ReferralsResponseSchema.safeParse({ ...referrals, earnedTiyin: 25000 }).success).toBe(
      false,
    );
  });

  it('the query pages with limit at most 100', () => {
    // Paging lives in the envelope's meta, never in data.
    expect(ReferralsResponseSchema.safeParse({ ...referrals, page: 1, total: 2 }).success).toBe(
      false,
    );
    expect(ReferralsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(ReferralsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ReferralsQuerySchema.safeParse({ userId: 'x' }).success).toBe(false);
  });
});

describe('discount codes', () => {
  it('tiers: coins and money as strings, every tier has a cap', () => {
    const tiers = [
      { id: ID, bps: 150, priceCoins: '90', maxDiscountTiyin: '1500000', validDays: 30 },
      { id: ID, bps: 20, priceCoins: '15', maxDiscountTiyin: '200000', validDays: 30 },
    ];
    expect(DiscountTiersResponseSchema.parse(tiers)).toEqual(tiers);
    const uncapped = { ...tiers[0], maxDiscountTiyin: null };
    expect(DiscountTiersResponseSchema.safeParse([uncapped]).success).toBe(false);
    expect(DiscountTiersResponseSchema.safeParse([{ ...tiers[0], bps: 10_000 }]).success).toBe(
      false,
    );
    expect(DiscountTiersResponseSchema.safeParse([{ ...tiers[0], priceCoins: 90 }]).success).toBe(
      false,
    );
  });

  it('the create body is strict: a tier id and nothing else', () => {
    expect(CreateDiscountCodeBodySchema.safeParse({ tierId: ID }).success).toBe(true);
    expect(CreateDiscountCodeBodySchema.safeParse({ tierId: ID, bps: 9_000 }).success).toBe(false);
    expect(CreateDiscountCodeBodySchema.safeParse({}).success).toBe(false);
  });

  it('a listed code: unused has null usedAt and orderNumber', () => {
    const unused = {
      id: ID,
      code: 'GG7KQ2MXP4',
      bps: 150,
      maxDiscountTiyin: '1500000',
      expiresAt: '2026-12-24T10:00:00.000Z',
      usedAt: null,
      orderNumber: null,
    };
    expect(DiscountCodeItemSchema.parse(unused)).toEqual(unused);
    const used = { ...unused, usedAt: '2026-11-25T10:00:00.000Z', orderNumber: 1042 };
    expect(DiscountCodeItemSchema.parse(used)).toEqual(used);
    expect(DiscountCodeItemSchema.safeParse({ ...unused, userId: ID }).success).toBe(false);
    const uncapped = { ...unused, maxDiscountTiyin: null };
    expect(DiscountCodeItemSchema.safeParse(uncapped).success).toBe(false);
  });

  it('the list filter takes ACTIVE, USED or EXPIRED and pages with limit at most 100', () => {
    expect(DiscountCodesQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    for (const status of ['ACTIVE', 'USED', 'EXPIRED']) {
      expect(DiscountCodesQuerySchema.parse({ status })).toEqual({ status, page: 1, limit: 20 });
    }
    expect(DiscountCodesQuerySchema.safeParse({ status: 'active' }).success).toBe(false);
    expect(DiscountCodesQuerySchema.parse({ page: '2', limit: '100' })).toEqual({
      page: 2,
      limit: 100,
    });
    expect(DiscountCodesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(DiscountCodesQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('the quote’s discountCode is the applied code or null', () => {
    expect(QuoteDiscountCodeSchema.parse(null)).toBeNull();
    expect(QuoteDiscountCodeSchema.parse({ code: 'GG7KQ2MXP4', bps: 150 })).toEqual({
      code: 'GG7KQ2MXP4',
      bps: 150,
    });
    expect(QuoteDiscountCodeSchema.safeParse({ code: 'GG7KQ2MXP4' }).success).toBe(false);
  });
});

describe('one rule for a typed code (redeem code, quote discountCode)', () => {
  it('both bodies take and refuse the same raw input', () => {
    const quote = (discountCode: string): boolean =>
      CreateQuoteBodySchema.safeParse({
        productId: 'prod_1',
        skuId: 's',
        recipientToken: 'A'.repeat(43),
        discountCode,
      }).success;
    const redeem = (code: string): boolean => RedeemBonusCodeBodySchema.safeParse({ code }).success;
    const tab = String.fromCodePoint(9);
    for (const code of ['GG3', 'GG-7KQ2-MXP4', 'A'.repeat(64), 'A'.repeat(65), ' ', `G${tab}G`]) {
      expect(quote(code), code).toBe(redeem(code));
    }
  });
});

describe('POST /bonus-codes/redeem', () => {
  it('the body is strict; only the raw length (64) here, 4..32 after normalisation', () => {
    expect(RedeemBonusCodeBodySchema.safeParse({ code: 'gg-5000' }).success).toBe(true);
    // Too short or too long once normalised is CODE_INVALID from the service, never a 400.
    expect(RedeemBonusCodeBodySchema.safeParse({ code: 'GG5' }).success).toBe(true);
    expect(RedeemBonusCodeBodySchema.safeParse({ code: 'A'.repeat(33) }).success).toBe(true);
    expect(RedeemBonusCodeBodySchema.safeParse({ code: 'A'.repeat(64) }).success).toBe(true);
    expect(RedeemBonusCodeBodySchema.safeParse({ code: 'A'.repeat(65) }).success).toBe(false);
    expect(RedeemBonusCodeBodySchema.safeParse({ code: '   ' }).success).toBe(false);
    const withNul = `GG${String.fromCodePoint(0)}5000`;
    expect(RedeemBonusCodeBodySchema.safeParse({ code: withNul }).success).toBe(false);
    expect(RedeemBonusCodeBodySchema.safeParse({ code: 'GG5000', userId: ID }).success).toBe(false);
  });

  it('the answer carries the amount of its own reward type only', () => {
    const wallet = { rewardType: 'WALLET', amountTiyin: '500000' };
    const coins = { rewardType: 'COINS', coins: '10' };
    expect(BonusRedeemResponseSchema.parse(wallet)).toEqual(wallet);
    expect(BonusRedeemResponseSchema.parse(coins)).toEqual(coins);
    expect(BonusRedeemResponseSchema.safeParse({ rewardType: 'WALLET', coins: '10' }).success).toBe(
      false,
    );
    expect(BonusRedeemResponseSchema.safeParse({ ...wallet, coins: '10' }).success).toBe(false);
    expect(
      BonusRedeemResponseSchema.safeParse({ rewardType: 'CASH', amountTiyin: '1' }).success,
    ).toBe(false);
  });
});
