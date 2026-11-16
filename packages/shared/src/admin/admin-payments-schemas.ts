// `/api/v1/admin/payments/*` (docs/04 "Admin" — payments; P2P cards D-31/D-37; plan S4, S6).
// Never on the wire: the full card number, the pay-link token or its hash, the provider txn id,
// the redacted provider `raw`. The raw bank text only to OWNER (`payments.bankMessageRaw`).
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import { RECONCILE_MISMATCH_CODES } from '../notify';
import { TiyinStringSchema } from '../money-schemas';
import {
  BANK_DIRECTIONS,
  BANK_PARSE_STATUSES,
  BankFeedSourceSchema,
  CardBankSchema,
  PAYMENT_REVIEW_RESOLUTIONS,
  PAYMENT_REVIEW_STATUSES,
  PaymentReviewKindSchema,
  TOPUP_CARD_STATUSES,
} from '../payments/bank-feed';
import { IntentStatusSchema } from '../payments/intent-state';
import {
  IsoDateTimeSchema,
  RANGE_ORDER_ISSUE,
  adminDateRangeShape,
  adminPageQueryShape,
  isOrderedRange,
} from './admin-common-schemas';

const CountSchema = z.number().int().min(0);
const Last4Schema = z.string().regex(/^\d{4}$/);

export const PAYMENT_STATUSES = ['CREATED', 'CONFIRMED', 'CANCELLED'] as const;
export const PAYMENT_PROVIDERS = [
  'CLICK',
  'PAYME',
  'UZUM',
  'RAHMAT',
  'TG_STARS',
  'P2P_CARD',
] as const;

export const AdminIntentListQuerySchema = z
  .strictObject({
    ...adminPageQueryShape,
    ...adminDateRangeShape,
    status: IntentStatusSchema.optional(),
    userId: ResourceIdSchema.optional(),
    cardId: ResourceIdSchema.optional(),
  })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE);
export type AdminIntentListQuery = z.infer<typeof AdminIntentListQuerySchema>;

export const AdminIntentRowSchema = z.strictObject({
  id: ResourceIdSchema,
  userId: ResourceIdSchema,
  status: IntentStatusSchema,
  amountTiyin: TiyinStringSchema,
  baseAmountTiyin: TiyinStringSchema.nullable(),
  card: z
    .strictObject({ id: ResourceIdSchema, bank: CardBankSchema, last4: Last4Schema })
    .nullable(),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
});
export const AdminIntentListResponseSchema = z.array(AdminIntentRowSchema);
export type AdminIntentListResponse = z.infer<typeof AdminIntentListResponseSchema>;

export const AdminPaymentListQuerySchema = z
  .strictObject({
    ...adminPageQueryShape,
    ...adminDateRangeShape,
    status: z.enum(PAYMENT_STATUSES).optional(),
    userId: ResourceIdSchema.optional(),
  })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE);
export type AdminPaymentListQuery = z.infer<typeof AdminPaymentListQuerySchema>;

export const AdminPaymentRowSchema = z.strictObject({
  id: ResourceIdSchema,
  userId: ResourceIdSchema,
  intentId: ResourceIdSchema.nullable(),
  provider: z.enum(PAYMENT_PROVIDERS),
  amountTiyin: TiyinStringSchema,
  status: z.enum(PAYMENT_STATUSES),
  bankMessageId: ResourceIdSchema.nullable(),
  reviewId: ResourceIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  confirmedAt: IsoDateTimeSchema.nullable(),
  cancelledAt: IsoDateTimeSchema.nullable(),
});
export type AdminPaymentRow = z.infer<typeof AdminPaymentRowSchema>;
export const AdminPaymentListResponseSchema = z.array(AdminPaymentRowSchema);
export type AdminPaymentListResponse = z.infer<typeof AdminPaymentListResponseSchema>;

export const AdminReviewListQuerySchema = z
  .strictObject({
    ...adminPageQueryShape,
    ...adminDateRangeShape,
    status: z.enum(PAYMENT_REVIEW_STATUSES).default('OPEN'),
    kind: PaymentReviewKindSchema.optional(),
    cardId: ResourceIdSchema.optional(),
  })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE);
export type AdminReviewListQuery = z.infer<typeof AdminReviewListQuerySchema>;

export const AdminReviewRowSchema = z.strictObject({
  id: ResourceIdSchema,
  kind: PaymentReviewKindSchema,
  status: z.enum(PAYMENT_REVIEW_STATUSES),
  resolution: z.enum(PAYMENT_REVIEW_RESOLUTIONS).nullable(),
  card: z
    .strictObject({ id: ResourceIdSchema, bank: CardBankSchema, last4: Last4Schema })
    .nullable(),
  intentId: ResourceIdSchema.nullable(),
  bankMessageId: ResourceIdSchema,
  amountTiyin: TiyinStringSchema.nullable(),
  direction: z.enum(BANK_DIRECTIONS).nullable(),
  bankTxnAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
});
export type AdminReviewRow = z.infer<typeof AdminReviewRowSchema>;
export const AdminReviewListResponseSchema = z.array(AdminReviewRowSchema);
export type AdminReviewListResponse = z.infer<typeof AdminReviewListResponseSchema>;

/**
 * A bank bot's message. Field level (`payments.bankMessageRaw`, OWNER only): `text` (the raw
 * message), `balanceAfterTiyin` (the card's balance) and `channel` are `null` for everyone else
 * (review SA-M5).
 */
export const AdminBankMessageSchema = z.strictObject({
  id: ResourceIdSchema,
  source: BankFeedSourceSchema,
  parseStatus: z.enum(BANK_PARSE_STATUSES),
  rejectReason: z.string().nullable(),
  direction: z.enum(BANK_DIRECTIONS).nullable(),
  amountTiyin: TiyinStringSchema.nullable(),
  balanceAfterTiyin: TiyinStringSchema.nullable(),
  last4: Last4Schema.nullable(),
  cardId: ResourceIdSchema.nullable(),
  channel: z.string().nullable(),
  tgDate: IsoDateTimeSchema,
  bankTxnAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  text: z.string().nullable(),
});
export const AdminBankMessageResponseSchema = AdminBankMessageSchema;
export type AdminBankMessageResponse = z.infer<typeof AdminBankMessageResponseSchema>;

export const AdminReviewDetailResponseSchema = AdminReviewRowSchema.extend({
  bankMessage: AdminBankMessageSchema,
  payment: AdminPaymentRowSchema.nullable(),
  note: z.string().nullable(),
  resolvedAuditId: ResourceIdSchema.nullable(),
});
export type AdminReviewDetailResponse = z.infer<typeof AdminReviewDetailResponseSchema>;

/** Exactly one of `userId` / `intentId`: who the money of the reviewed message goes to. */
export const adminCreditTargetShape = {
  userId: ResourceIdSchema.optional(),
  intentId: ResourceIdSchema.optional(),
} as const;
export const isOneCreditTarget = (t: {
  readonly userId?: string;
  readonly intentId?: string;
}): boolean => (t.userId === undefined) !== (t.intentId === undefined);
export const ONE_CREDIT_TARGET_ISSUE = {
  message: 'give exactly one of userId or intentId',
  path: ['userId'],
};

export const AdminCreditPreviewQuerySchema = z
  .strictObject(adminCreditTargetShape)
  .refine(isOneCreditTarget, ONE_CREDIT_TARGET_ISSUE);
export type AdminCreditPreviewQuery = z.infer<typeof AdminCreditPreviewQuerySchema>;

const HandCreditsSchema = z.strictObject({ count: CountSchema, sumTiyin: TiyinStringSchema });

/**
 * `GET /admin/payments/reviews/:id/credit-preview` (OWNER): what the CLI's `review:credit` prints
 * before it asks anything. `overrideNeeded` names why `confirmOverride` is needed (blocked user,
 * over the daily limit); `manualCreditsSinceRequest` is money already given by hand (D-47).
 */
export const AdminCreditPreviewResponseSchema = z.strictObject({
  amountTiyin: TiyinStringSchema,
  userId: ResourceIdSchema,
  blocked: z.boolean(),
  purchaseFrozen: z.boolean(),
  accountAgeDays: CountSchema,
  overLimit: z.boolean(),
  overrideNeeded: z.string().nullable(),
  needsBankVerification: z.boolean(),
  manualCreditsSinceRequest: z.strictObject({
    adjust: HandCreditsSchema,
    reviewCredit: HandCreditsSchema,
    since: IsoDateTimeSchema,
  }),
});
export type AdminCreditPreviewResponse = z.infer<typeof AdminCreditPreviewResponseSchema>;

export const AdminCardSchema = z.strictObject({
  id: ResourceIdSchema,
  bank: CardBankSchema,
  last4: Last4Schema,
  holderName: z.string(),
  status: z.enum(TOPUP_CARD_STATUSES),
  receiveLimitTiyin: TiyinStringSchema,
  monthlyLimitTiyin: TiyinStringSchema.nullable(),
  /** PARSED CREDITs since verification / since the Tashkent month start (card-capacity.ts). */
  receivedTiyin: TiyinStringSchema,
  receivedMonthTiyin: TiyinStringSchema,
  reservedTiyin: TiyinStringSchema,
  usagePercent: z.number().int().min(0),
  autoCreditPaused: z.boolean(),
  verifiedAt: IsoDateTimeSchema.nullable(),
  retiredAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AdminCard = z.infer<typeof AdminCardSchema>;
export const AdminCardListResponseSchema = z.array(AdminCardSchema);
export type AdminCardListResponse = z.infer<typeof AdminCardListResponseSchema>;

export const AdminReconcileQuerySchema = z
  .strictObject({ ...adminPageQueryShape, ...adminDateRangeShape })
  .refine(isOrderedRange, RANGE_ORDER_ISSUE);
export type AdminReconcileQuery = z.infer<typeof AdminReconcileQuerySchema>;

const mismatchRecord = <T extends z.ZodType>(value: T) =>
  z.strictObject(
    Object.fromEntries(RECONCILE_MISMATCH_CODES.map((code) => [code, value])) as Record<
      (typeof RECONCILE_MISMATCH_CODES)[number],
      T
    >,
  );

/** One daily reconcile report (the worker's `PAYMENT_RECONCILE` audit row, Tashkent day). */
export const AdminReconcileDaySchema = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  auditId: ResourceIdSchema,
  createdAt: IsoDateTimeSchema,
  ok: z.boolean(),
  checkedMessages: CountSchema,
  debits: CountSchema,
  openReviews: CountSchema,
  historyScan: z.string().max(32),
  mismatches: mismatchRecord(CountSchema),
  examples: mismatchRecord(z.array(ResourceIdSchema).max(20)),
});
export const AdminReconcileResponseSchema = z.array(AdminReconcileDaySchema);
export type AdminReconcileResponse = z.infer<typeof AdminReconcileResponseSchema>;
