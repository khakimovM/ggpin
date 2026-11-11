// Wallet top-up by P2P card transfer (docs/04 "To‘lovlar (P2P)", docs/05, D-31/D-37/D-39).
// These describe the `data` payload; the envelope is in the API. Requests are `.strict()`
// (rules/60-security.md). Money is a string of tiyin. Whether an amount is a multiple of the
// step or inside min/max is a business rule answered with `422 TOPUP_AMOUNT_OUT_OF_RANGE`
// (+ details), not a 400, so the body schema checks only the wire format.
import { z } from 'zod';
import { LIST_MAX_LIMIT, ResourceIdSchema } from '../common-schemas';
import { TiyinStringSchema } from '../money-schemas';
import { CardBankSchema } from './bank-feed';
import { IntentStatusSchema } from './intent-state';
import { OwnerHintSchema, PayLinkUrlSchema } from './pay-link';

export const TOPUP_PROVIDER = 'P2P_CARD' as const;

/**
 * The base amount is a multiple of this in the database (`PaymentIntent_p2p_check`:
 * `baseAmountTiyin % 100000 = 0`), so the env step must be a multiple of it as well.
 */
export const TOPUP_BASE_UNIT_TIYIN = 100_000n;

/**
 * Defaults of the env-tunable top-up limits (D-37 (7)). API and worker both read
 * `TOPUP_LATE_GRACE_SEC` and must agree on it, hence one place. Tiyin: 1 so'm = 100.
 */
export const TOPUP_DEFAULTS = {
  MIN_TIYIN: 500_000n, // 5 000 so'm
  MAX_TIYIN: 200_000_000n, // 2 000 000 so'm per request
  STEP_TIYIN: TOPUP_BASE_UNIT_TIYIN, // base amount is a multiple of 1 000 so'm
  SUFFIX_MAX_SOM: 999, // unique extra of 1..999 so'm
  INTENT_TTL_SEC: 1800, // 30 minutes
  LATE_GRACE_SEC: 86_400, // the amount stays reserved 24 h after expiry (or after payment)
  // An UNPAID request (pending, expired or cancelled) counts against its card's limit only this
  // long after expiresAt (D-42 (1)); its amount stays reserved for the whole grace.
  CAPACITY_HOLD_SEC: 3_600,
  NEW_ACCOUNT_AGE_SEC: 604_800, // accounts younger than 7 days are "new"
  NEW_ACCOUNT_DAILY_MAX_TIYIN: 50_000_000n, // 500 000 so'm per 24 h for a new account
  // Daily caps count the BASE amounts (see topup-limits.ts), never the random 1-999 so'm extra.
  DAILY_MAX_TIYIN: 500_000_000n, // 5 000 000 so'm per 24 h for EVERY account (TOPUP_DAILY_MAX_TIYIN)
  // UNPAID intents holding an amount: PENDING, and EXPIRED or CANCELLED with reservedUntil > now.
  // PAID ones do not count: the limit stops "create, cancel, repeat" hoarding, and a paid
  // request is real money, not hoarding.
  MAX_RESERVED_PER_USER: 3,
  CREATE_LIMIT_PER_WINDOW: 5,
  CREATE_LIMIT_WINDOW_SEC: 600,
  // Created PaymentIntents per rolling 24 h. Refused attempts (409, 422, 429, 503) create no
  // intent and are not counted: the 5-per-10-minutes limit already covers them.
  DAILY_CREATE_LIMIT: 10,
  DAILY_CREATE_WINDOW_SEC: 86_400,
} as const;

/** The unique extra is whole so'm, within 1..999, so the pay amount minus the base is 100..99 900 tiyin. */
const SUFFIX_MIN_TIYIN = 100n;
const SUFFIX_MAX_TIYIN = 99_900n;

// ---- the receiving card shown to the intent owner ---------------------------------------------
// Our own card (D-37 (11)), not customer data: shown only to the owner of a PENDING intent.
// `holderName` is the SHORT form (`ALISHER K.`, see shortHolderName): the full name never leaves
// the API, and is not needed to recognise the recipient in the bank app.
export const TopupCardViewSchema = z.strictObject({
  bank: CardBankSchema,
  /** 16 digits, no separators; the client formats it. */
  number: z.string().regex(/^\d{16}$/),
  holderName: z.string().min(1).max(64),
});
export type TopupCardView = z.infer<typeof TopupCardViewSchema>;

// ---- POST /payments/intents -------------------------------------------------------------------
export const CreateTopupIntentBodySchema = z.strictObject({
  provider: z.literal(TOPUP_PROVIDER),
  amountTiyin: TiyinStringSchema,
  // TOPUP_AND_BUY exists in the contract's vocabulary but is phase 5 (D-37 (10)): until then it is
  // not a valid value, so it answers 400 VALIDATION_ERROR like any unknown enum member.
  purpose: z.literal('TOPUP'),
  // Absent = automatic: the card with the most free capacity, either bank.
  bank: CardBankSchema.optional(),
});
export type CreateTopupIntentBody = z.infer<typeof CreateTopupIntentBodySchema>;

const amountPairShape = {
  baseAmountTiyin: TiyinStringSchema,
  payAmountTiyin: TiyinStringSchema,
};

// An object-level refinement runs even when a field already failed its own check, and
// `BigInt('1.5')` throws; a thrown error from a schema would become a 500 on a request or a
// crash on a response parse. So the digits are checked first.
const DIGITS = /^\d+$/;
function hasValidSuffix(value: { baseAmountTiyin: string; payAmountTiyin: string }): boolean {
  if (!DIGITS.test(value.baseAmountTiyin) || !DIGITS.test(value.payAmountTiyin)) return false;
  const extra = BigInt(value.payAmountTiyin) - BigInt(value.baseAmountTiyin);
  return extra >= SUFFIX_MIN_TIYIN && extra <= SUFFIX_MAX_TIYIN && extra % 100n === 0n;
}

// The card is shown only while the request is waiting for money, and then it must be there.
function cardMatchesStatus(value: { status: string; card: unknown }): boolean {
  return (value.status === 'PENDING') === (value.card !== null);
}
// Paid exactly when PAID: the timestamp and the credited amount appear together with the status.
function paidFieldsMatchStatus(value: {
  status: string;
  paidAt: unknown;
  creditedTiyin: unknown;
}): boolean {
  const paid = value.status === 'PAID';
  return paid === (value.paidAt !== null) && paid === (value.creditedTiyin !== null);
}
const CARD_ISSUE = { message: 'card is present exactly while status is PENDING', path: ['card'] };
const PAID_ISSUE = {
  message: 'paidAt and creditedTiyin are set exactly when status is PAID',
  path: ['paidAt'],
};
const SUFFIX_ISSUE = {
  message: 'payAmountTiyin must exceed baseAmountTiyin by 1..999 whole so‘m',
  path: ['payAmountTiyin'],
};

/** 201 of `POST /payments/intents`. `redirectUrl` carries the pay-link token in its fragment. */
export const TopupIntentCreatedSchema = z
  .strictObject({
    intentId: ResourceIdSchema,
    status: z.literal('PENDING'),
    ...amountPairShape,
    card: TopupCardViewSchema,
    expiresAt: z.iso.datetime(),
    redirectUrl: PayLinkUrlSchema,
    currency: z.literal('UZS'),
  })
  .refine(hasValidSuffix, SUFFIX_ISSUE);
export type TopupIntentCreated = z.infer<typeof TopupIntentCreatedSchema>;

/** `GET /payments/intents/:id` and each item of `GET /payments/intents`. */
export const TopupIntentSchema = z
  .strictObject({
    intentId: ResourceIdSchema,
    status: IntentStatusSchema,
    ...amountPairShape,
    /** Only while PENDING: nobody should be sent to a card for a request that is over. */
    card: TopupCardViewSchema.nullable(),
    expiresAt: z.iso.datetime(),
    paidAt: z.iso.datetime().nullable(),
    /** What the wallet was actually credited (the full received amount); null until PAID. */
    creditedTiyin: TiyinStringSchema.nullable(),
    currency: z.literal('UZS'),
  })
  .refine(hasValidSuffix, SUFFIX_ISSUE)
  .refine(cardMatchesStatus, CARD_ISSUE)
  .refine(paidFieldsMatchStatus, PAID_ISSUE);
export type TopupIntent = z.infer<typeof TopupIntentSchema>;

export const IntentListQuerySchema = z.strictObject({
  status: IntentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(20),
});
export type IntentListQuery = z.infer<typeof IntentListQuerySchema>;

export const IntentParamsSchema = z.strictObject({ id: ResourceIdSchema });
export type IntentParams = z.infer<typeof IntentParamsSchema>;

// ---- POST /payments/intents/:id/cancel and /pay-link -------------------------------------------
export const CancelTopupIntentBodySchema = z.strictObject({});
export const CancelTopupIntentResponseSchema = z.strictObject({
  intentId: ResourceIdSchema,
  status: z.literal('CANCELLED'),
});
export type CancelTopupIntentResponse = z.infer<typeof CancelTopupIntentResponseSchema>;

export const PayLinkBodySchema = z.strictObject({});
export const PayLinkResponseSchema = z.strictObject({
  redirectUrl: PayLinkUrlSchema,
  expiresAt: z.iso.datetime(),
});
export type PayLinkResponse = z.infer<typeof PayLinkResponseSchema>;

// ---- GET /payments/methods ---------------------------------------------------------------------
export const PaymentMethodsResponseSchema = z.array(
  z.strictObject({
    code: z.literal(TOPUP_PROVIDER),
    available: z.boolean(),
    banks: z.array(z.strictObject({ bank: CardBankSchema, available: z.boolean() })),
    minTiyin: TiyinStringSchema,
    maxTiyin: TiyinStringSchema,
    stepTiyin: TiyinStringSchema,
  }),
);
export type PaymentMethodsResponse = z.infer<typeof PaymentMethodsResponseSchema>;

// ---- GET /payments/pay/:intentId (public, capability token in X-Pay-Token) ----------------------
// Any failure of this endpoint, including a malformed `intentId`, is the same 404 (D-39), so the
// path parameter is NOT validated by a schema that would answer 400: the controller takes a
// string and the service answers 404 for anything it cannot resolve.
export const PayViewParamsSchema = z.strictObject({ intentId: z.string().max(128) });
export type PayViewParams = z.infer<typeof PayViewParamsSchema>;

/**
 * Everything the pay page may learn with the token, and nothing else: no user id, username,
 * balance, ledger or other intents. `card` only while PENDING. `ownerHint` (see maskOwnerHint)
 * lets a payer who got the link from someone else see that it is not their own account.
 */
export const PayViewSchema = z
  .strictObject({
    intentId: ResourceIdSchema,
    status: IntentStatusSchema,
    ...amountPairShape,
    card: TopupCardViewSchema.nullable(),
    expiresAt: z.iso.datetime(),
    ownerHint: OwnerHintSchema.nullable(),
    currency: z.literal('UZS'),
  })
  .refine(hasValidSuffix, SUFFIX_ISSUE)
  .refine(cardMatchesStatus, CARD_ISSUE);
export type PayView = z.infer<typeof PayViewSchema>;

// ---- error details (docs/04 "Xato kodlari") -----------------------------------------------------
export const TOPUP_LIMIT_REASONS = ['DAILY_LIMIT', 'NEW_ACCOUNT_DAILY_LIMIT'] as const;
export const TopupAmountOutOfRangeDetailsSchema = z.strictObject({
  min: TiyinStringSchema,
  max: TiyinStringSchema,
  step: TiyinStringSchema,
  /**
   * Absent: the per-request range or step. `DAILY_LIMIT`: the 24 h cap every account has.
   * `NEW_ACCOUNT_DAILY_LIMIT`: the lower 24 h cap of an account younger than 7 days.
   */
  reason: z.enum(TOPUP_LIMIT_REASONS).optional(),
});
export type TopupAmountOutOfRangeDetails = z.infer<typeof TopupAmountOutOfRangeDetailsSchema>;

export const TopupAlreadyPendingDetailsSchema = z.strictObject({ intentId: ResourceIdSchema });
export type TopupAlreadyPendingDetails = z.infer<typeof TopupAlreadyPendingDetailsSchema>;

/**
 * `409 IDEMPOTENCY_CONFLICT` on `POST /payments/intents` with a known key: a different body, or
 * the same body whose intent is no longer PENDING and unexpired (it cannot be handed out
 * again). `intentId` is the caller's own intent, found with `WHERE userId = session`.
 */
export const IdempotencyConflictDetailsSchema = z.strictObject({ intentId: ResourceIdSchema });
export type IdempotencyConflictDetails = z.infer<typeof IdempotencyConflictDetailsSchema>;
