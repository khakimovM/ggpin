// Promo rates and limits (phase 10, D-72 (3)-(5), (10)). The rates live in the `Setting` table
// (key -> JSON value), only the OWNER changes them (with an AuditLog row), and a delivery reads
// them inside its own transaction. A stored value that fails this schema is never "fixed up":
// the delivery grants nothing and the owner is alerted (plan 3.1, `SETTINGS_INVALID`).
import { z } from 'zod';
import { TiyinStringSchema } from '../money-schemas';

/** The `Setting.key` of each promo value. */
export const PROMO_SETTING_KEYS = {
  referralBps: 'REFERRAL_BPS',
  cashbackBps: 'CASHBACK_BPS',
  coinUnitTiyin: 'COIN_UNIT_TIYIN',
  referralDailyCapTiyin: 'REFERRAL_DAILY_CAP_TIYIN',
} as const;

/** Referral and cashback are each at most 3% (D-72 (10)). */
export const PROMO_RATE_MAX_BPS = 300;
/** Referral + cashback + the biggest active discount tier: at most 5% (D-72 (10)). */
export const PROMO_TOTAL_MAX_BPS = 500;
/** A user holds at most this many unused, unexpired discount codes (D-72 (5)). */
export const ACTIVE_DISCOUNT_CODES_MAX = 5;

const RateBpsSchema = z.number().int().min(0).max(PROMO_RATE_MAX_BPS);
// Money in JSON is a string (CLAUDE.md invariant 1); a unit or a cap of zero is a broken setting.
const PositiveTiyinSchema = TiyinStringSchema.refine((value) => value !== '0', {
  message: 'must be positive',
});

/**
 * The four Setting rows (PROMO_SETTING_KEYS) put together, each under its field name: bps as JSON
 * numbers, tiyin as decimal strings.
 */
export const PromoSettingsSchema = z.strictObject({
  referralBps: RateBpsSchema,
  cashbackBps: RateBpsSchema,
  coinUnitTiyin: PositiveTiyinSchema,
  referralDailyCapTiyin: PositiveTiyinSchema,
});
export type PromoSettingsStored = z.infer<typeof PromoSettingsSchema>;

/** The parsed form the reward math takes. */
export interface PromoSettings {
  readonly referralBps: number;
  readonly cashbackBps: number;
  readonly coinUnitTiyin: bigint;
  readonly referralDailyCapTiyin: bigint;
}

/** D-72: 1% referral, 0.5% cashback, 1 coin = 100 so'm, 100 000 so'm per inviter per day. */
export const PROMO_SETTINGS_DEFAULT: PromoSettings = Object.freeze({
  referralBps: 100,
  cashbackBps: 50,
  coinUnitTiyin: 10_000n,
  referralDailyCapTiyin: 10_000_000n,
});

/** The stored values as numbers and bigints, or null when any of them is missing or out of range. */
export function parsePromoSettings(stored: unknown): PromoSettings | null {
  const parsed = PromoSettingsSchema.safeParse(stored);
  if (!parsed.success) return null;
  return {
    referralBps: parsed.data.referralBps,
    cashbackBps: parsed.data.cashbackBps,
    coinUnitTiyin: BigInt(parsed.data.coinUnitTiyin),
    referralDailyCapTiyin: BigInt(parsed.data.referralDailyCapTiyin),
  };
}

/**
 * True when referral + cashback + the biggest active tier stay within PROMO_TOTAL_MAX_BPS, so the
 * rewards can never eat the markup (D-72 (10)). Checked when the owner changes a rate or a tier.
 */
export function withinPromoBudget(settings: PromoSettings, maxTierBps: number): boolean {
  if (!Number.isSafeInteger(maxTierBps) || maxTierBps < 0) return false;
  return settings.referralBps + settings.cashbackBps + maxTierBps <= PROMO_TOTAL_MAX_BPS;
}

/** One discount tier as the seed and the owner set it (D-72 (5)). */
export interface DiscountTierDefault {
  readonly bps: number;
  readonly priceCoins: bigint;
  readonly maxDiscountTiyin: bigint;
  readonly validDays: number;
}

/** The designed tiers: 0.2% / 15, 0.5% / 35, 1% / 70, 1.5% / 90 coins; caps 2 000..15 000 so'm. */
export const DISCOUNT_TIERS_DEFAULT: readonly DiscountTierDefault[] = Object.freeze([
  { bps: 20, priceCoins: 15n, maxDiscountTiyin: 200_000n, validDays: 30 },
  { bps: 50, priceCoins: 35n, maxDiscountTiyin: 500_000n, validDays: 30 },
  { bps: 100, priceCoins: 70n, maxDiscountTiyin: 1_000_000n, validDays: 30 },
  { bps: 150, priceCoins: 90n, maxDiscountTiyin: 1_500_000n, validDays: 30 },
]);
