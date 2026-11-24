// Referral, discount code and bonus code requests and responses (docs/04 "Referal, keshbek,
// promo", phase 10). These describe the `data` payload; the envelope is in the API. Money and
// coins are decimal strings; writes are `.strict()` (.claude/rules/60-security.md).
import { z } from 'zod';
import { NO_CONTROL_CHARS, ResourceIdSchema, pageQueryShape } from '../common-schemas';
import { TiyinStringSchema } from '../money-schemas';
import {
  PROMO_CODE_MAX_LENGTH,
  PROMO_CODE_MIN_LENGTH,
  PROMO_CODE_RAW_MAX_LENGTH,
} from './promo-codes';

/** Coins are a non-negative whole count, a decimal string like money (a CoinEntry sum is a BIGINT). */
const CoinsStringSchema = TiyinStringSchema;
const BpsSchema = z.number().int().min(0).max(9_999);

/**
 * A typed promo code as a request carries it (redeem `code`, quote `discountCode`): one rule for
 * both. Only the raw length is bounded here; the 4..32 canonical length is checked AFTER
 * normalisation (normalizePromoCode), and a code that fails it is `CODE_INVALID`, never a 400.
 */
export const PromoCodeInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROMO_CODE_RAW_MAX_LENGTH)
  .regex(NO_CONTROL_CHARS);

// ---- GET /referrals ----

export const ReferralsQuerySchema = z.strictObject({ ...pageQueryShape });
export type ReferralsQuery = z.infer<typeof ReferralsQuerySchema>;

/** One invited user. No Telegram id, no phone; the username is masked (`@ab***`, D-72 (13)). */
export const ReferralInvitedSchema = z.strictObject({
  displayName: z.string().max(256).nullable(),
  usernameMasked: z.string().max(64).nullable(),
  joinedAt: z.iso.datetime(),
  /** Net bonus from this user: grants minus reversals (D-72 (13)). */
  earnedTiyin: TiyinStringSchema,
});
export type ReferralInvited = z.infer<typeof ReferralInvitedSchema>;

export const ReferralsResponseSchema = z.strictObject({
  /** `https://t.me/<bot>?start=ref_<code>` (opens the bot). */
  link: z.url(),
  /** `https://t.me/<bot>?startapp=ref_<code>` (opens the Mini App). */
  miniAppLink: z.url(),
  invitedCount: z.number().int().min(0),
  /** Net bonus from all invited users. */
  earnedTiyin: TiyinStringSchema,
  /** The referral rate in force now (Setting REFERRAL_BPS). */
  rateBps: BpsSchema,
  /** One page of invited users, newest first; paging is in the envelope's `meta`. */
  invited: z.array(ReferralInvitedSchema),
});
export type ReferralsResponse = z.infer<typeof ReferralsResponseSchema>;

// ---- discount codes ----

export const DiscountTierItemSchema = z.strictObject({
  id: ResourceIdSchema,
  bps: BpsSchema,
  priceCoins: CoinsStringSchema,
  /** The most one code of this tier takes off an order (every tier has a cap, D-72 (5)). */
  maxDiscountTiyin: TiyinStringSchema,
  validDays: z.number().int().min(1),
});
export type DiscountTierItem = z.infer<typeof DiscountTierItemSchema>;

export const DiscountTiersResponseSchema = z.array(DiscountTierItemSchema);
export type DiscountTiersResponse = z.infer<typeof DiscountTiersResponseSchema>;

/** POST /discounts/codes (with an `Idempotency-Key` header). */
export const CreateDiscountCodeBodySchema = z.strictObject({ tierId: ResourceIdSchema });
export type CreateDiscountCodeBody = z.infer<typeof CreateDiscountCodeBodySchema>;

export const DiscountCodeCreatedSchema = z.strictObject({
  id: ResourceIdSchema,
  code: z.string().min(PROMO_CODE_MIN_LENGTH).max(PROMO_CODE_MAX_LENGTH),
  bps: BpsSchema,
  maxDiscountTiyin: TiyinStringSchema,
  expiresAt: z.iso.datetime(),
});
export type DiscountCodeCreated = z.infer<typeof DiscountCodeCreatedSchema>;

export const DISCOUNT_CODE_STATUSES = ['ACTIVE', 'USED', 'EXPIRED'] as const;
export const DiscountCodeStatusSchema = z.enum(DISCOUNT_CODE_STATUSES);
export type DiscountCodeStatus = z.infer<typeof DiscountCodeStatusSchema>;

export const DiscountCodesQuerySchema = z.strictObject({
  status: DiscountCodeStatusSchema.optional(),
  ...pageQueryShape,
});
export type DiscountCodesQuery = z.infer<typeof DiscountCodesQuerySchema>;

export const DiscountCodeItemSchema = DiscountCodeCreatedSchema.extend({
  /** When the order that used the code was placed; null while unused. */
  usedAt: z.iso.datetime().nullable(),
  /** The `#` of that order; null while unused. */
  orderNumber: z.number().int().min(1).nullable(),
});
export type DiscountCodeItem = z.infer<typeof DiscountCodeItemSchema>;

/** One page of codes, newest first; paging is in the envelope's `meta` (limit <= 100). */
export const DiscountCodesResponseSchema = z.array(DiscountCodeItemSchema);
export type DiscountCodesResponse = z.infer<typeof DiscountCodesResponseSchema>;

/** `discountCode` of a quote response (docs/04 POST /quotes): the code applied, or null. */
export const QuoteDiscountCodeSchema = z
  .strictObject({
    code: z.string().min(PROMO_CODE_MIN_LENGTH).max(PROMO_CODE_MAX_LENGTH),
    bps: BpsSchema,
  })
  .nullable();
export type QuoteDiscountCode = z.infer<typeof QuoteDiscountCodeSchema>;

// ---- POST /bonus-codes/redeem ----

/** The typed code; spaces, dashes, case and Cyrillic look-alikes are normalised by the service. */
export const RedeemBonusCodeBodySchema = z.strictObject({ code: PromoCodeInputSchema });
export type RedeemBonusCodeBody = z.infer<typeof RedeemBonusCodeBodySchema>;

export const BonusRedeemResponseSchema = z.discriminatedUnion('rewardType', [
  z.strictObject({ rewardType: z.literal('WALLET'), amountTiyin: TiyinStringSchema }),
  z.strictObject({ rewardType: z.literal('COINS'), coins: CoinsStringSchema }),
]);
export type BonusRedeemResponse = z.infer<typeof BonusRedeemResponseSchema>;
