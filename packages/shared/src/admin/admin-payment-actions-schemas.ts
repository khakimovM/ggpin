// Write bodies and results of `/api/v1/admin/payments/*` (OWNER only, D-63 (3)): the HTTP form of
// the owner CLI's `review:credit`, `payment:reverse` and `card:pause|resume|limit|retire`. The
// same services run behind them (plan S6); `card:add` stays CLI-only (full card number, D-63 (6)).
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';
import {
  AdminOtpAnswerSchema,
  AdminReasonSchema,
  PositiveTiyinStringSchema,
  adminActionResultShape,
  adminConfirmationShape,
  adminStateResultShape,
} from './admin-common-schemas';
import {
  AdminCardSchema,
  ONE_CREDIT_TARGET_ISSUE,
  adminCreditTargetShape,
  isOneCreditTarget,
} from './admin-payments-schemas';

/**
 * `POST /admin/payments/reviews/:id/credit`. `confirmOverride` / `bankVerified` are the CLI's
 * `--confirm-override` / `--bank-verified`: the server recomputes what they cover under its
 * locks and binds them to the code (D-46 (2)).
 */
export const AdminReviewCreditBodySchema = z
  .strictObject({
    ...adminCreditTargetShape,
    reason: AdminReasonSchema,
    confirmOverride: z.boolean().default(false),
    bankVerified: z.boolean().default(false),
    ...adminConfirmationShape,
  })
  .refine(isOneCreditTarget, ONE_CREDIT_TARGET_ISSUE);
export type AdminReviewCreditBody = z.infer<typeof AdminReviewCreditBodySchema>;

export const AdminReviewCreditResponseSchema = z.strictObject({
  reviewId: ResourceIdSchema,
  paymentId: ResourceIdSchema,
  userId: ResourceIdSchema,
  intentId: ResourceIdSchema.nullable(),
  amountTiyin: TiyinStringSchema,
  ...adminActionResultShape,
});
export type AdminReviewCreditResponse = z.infer<typeof AdminReviewCreditResponseSchema>;

/** `POST /admin/payments/:id/reverse` — TOPUP_REVERSAL of a confirmed top-up. */
export const AdminPaymentReverseBodySchema = z.strictObject({
  reason: AdminReasonSchema,
  ...adminConfirmationShape,
});
export type AdminPaymentReverseBody = z.infer<typeof AdminPaymentReverseBodySchema>;

export const AdminPaymentReverseResponseSchema = z.strictObject({
  paymentId: ResourceIdSchema,
  userId: ResourceIdSchema,
  ledgerEntryId: ResourceIdSchema,
  /** Negative when the money was already spent; then purchases are frozen (`frozen`). */
  balanceTiyin: SignedTiyinStringSchema,
  frozen: z.boolean(),
  ...adminActionResultShape,
});
export type AdminPaymentReverseResponse = z.infer<typeof AdminPaymentReverseResponseSchema>;

export const AdminCardPauseBodySchema = z.strictObject({ reason: AdminReasonSchema });
export type AdminCardPauseBody = z.infer<typeof AdminCardPauseBodySchema>;

/**
 * The CLI's `card:resume --confirm-override --confirm-security-pause`. Lifting a SECURITY pause
 * needs the acting OWNER's code (D-65 D3); there is no amount to re-type.
 */
export const AdminCardResumeBodySchema = z.strictObject({
  reason: AdminReasonSchema,
  confirmOverride: z.boolean().default(false),
  confirmSecurityPause: z.boolean().default(false),
  otp: AdminOtpAnswerSchema.optional(),
});
export type AdminCardResumeBody = z.infer<typeof AdminCardResumeBodySchema>;

/** `monthlyLimitTiyin: null` removes the monthly cap; leaving it out keeps the current one. */
export const AdminCardLimitBodySchema = z.strictObject({
  receiveLimitTiyin: PositiveTiyinStringSchema,
  monthlyLimitTiyin: PositiveTiyinStringSchema.nullable().optional(),
  reason: AdminReasonSchema,
});
export type AdminCardLimitBody = z.infer<typeof AdminCardLimitBodySchema>;

/** `emergency: true` = RETIRED now and its PENDING requests cancelled (`CARD_RETIRE_EMERGENCY`). */
export const AdminCardRetireBodySchema = z.strictObject({
  reason: AdminReasonSchema,
  emergency: z.boolean().default(false),
});
export type AdminCardRetireBody = z.infer<typeof AdminCardRetireBodySchema>;

export const AdminCardChangeResponseSchema = z.strictObject({
  card: AdminCardSchema,
  /** PENDING top-up requests cancelled by this change (emergency retire), else 0. */
  cancelledIntents: z.number().int().min(0),
  ...adminStateResultShape,
});
export type AdminCardChangeResponse = z.infer<typeof AdminCardChangeResponseSchema>;
