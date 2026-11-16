// Building blocks of every admin request and response (docs/04 "Admin", phase 9 S1). Write
// bodies are strict objects (an unknown key is a 400), money is a decimal string of tiyin
// (money-schemas.ts), times are ISO 8601 UTC, lists are paginated with `limit` <= 100.
import { z } from 'zod';
import { NO_CONTROL_CHARS, ResourceIdSchema, pageQueryShape } from '../common-schemas';
import { SignedTiyinStringSchema, TiyinStringSchema } from '../money-schemas';

export const IsoDateTimeSchema = z.iso.datetime();

/** `?page=&limit=` of every admin list: limit 1..100 (default 20), page 1..10 000. */
export const adminPageQueryShape = pageQueryShape;

/** Optional `from` / `to` (ISO 8601 UTC, `from` inclusive, `to` exclusive). */
export const adminDateRangeShape = {
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
} as const;

/** `from` must not be after `to`; use with `.refine` on a query object. */
export function isOrderedRange(range: { readonly from?: string; readonly to?: string }): boolean {
  if (range.from === undefined || range.to === undefined) return true;
  return Date.parse(range.from) <= Date.parse(range.to);
}
export const RANGE_ORDER_ISSUE = { message: 'from must not be after to', path: ['from'] };

/** A positive amount (a refund, a limit): "0" is refused on top of the money shape. */
export const PositiveTiyinStringSchema = TiyinStringSchema.refine((value) => value !== '0', {
  message: 'amount must be positive',
});

/** A signed non-zero amount (a wallet adjustment: + credit, − debit). */
export const NonZeroSignedTiyinStringSchema = SignedTiyinStringSchema.refine(
  (value) => value !== '0',
  { message: 'amount must not be zero' },
);

/**
 * A non-negative integer of minor units other than tiyin (nanoTON, micro-USDT, the cost currency
 * of an order): the same decimal-string BIGINT shape as tiyin.
 */
export const MinorUnitsStringSchema = TiyinStringSchema;

/** A Telegram user id as a decimal string (BIGINT in the database, too big for a JSON number). */
export const TelegramIdStringSchema = z.string().regex(/^[1-9]\d{0,18}$/);

// No control or format characters (zero-width, bidi overrides) and no line separators: a bidi
// override can make an audit line read differently from what was typed. The same set as the
// owner CLI's `checkedReason` (apps/api common/admin/admin-input.ts).
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function visibleText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !INVISIBLE.test(value) && HAS_LETTER_OR_DIGIT.test(value), {
      message: 'visible text with a letter or digit',
    });
}

/**
 * One line of catalog text (name, label, tab, supplier SKU, region badge): no control or format
 * character (NUL, bidi overrides, zero-width) and no line or paragraph separator.
 */
export function adminSingleLine(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !INVISIBLE.test(value), { message: 'visible single-line text' });
}

// Multi-line text keeps `\n` as its only invisible character (no `\r`, tab, bidi, U+2028).
const MULTI_LINE = /^(?:\n|[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}])+$/u;

/** A description or help text: like `adminSingleLine`, but `\n` is allowed. */
export function adminMultiLine(max: number) {
  return z.string().trim().min(1).max(max).regex(MULTI_LINE);
}

// Characters that render as blank although Unicode calls them letters or symbols (Hangul fillers,
// the half-width filler, the blank Braille pattern): a name made of them looks empty (review N9).
const BLANK_LOOKALIKES = /[ᅟᅠㅤﾠ⠀]/u;

/**
 * An admin's display name, 1..64 visible characters with at least one letter or digit: it is
 * shown in alerts and audit rows, so no invisible or blank-looking character, no line separator
 * and no `<` / `>` (bot HTML is escaped as well, S2).
 */
export const AdminNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]+$/u)
  .refine((value) => !BLANK_LOOKALIKES.test(value) && HAS_LETTER_OR_DIGIT.test(value), {
    message: 'a visible name with a letter or digit',
  });

/**
 * A non-negative integer from a query string (`?limit=`): plain decimal digits only, so `1e3`,
 * `0x10`, ` 5` and `` are refused, unlike `z.coerce.number()` (review N6).
 */
export function adminQueryInt(max: number) {
  return z
    .string()
    .regex(/^(0|[1-9]\d{0,9})$/)
    .transform(Number)
    .pipe(z.number().int().max(max));
}

export const ADMIN_REASON_MIN_LENGTH = 10;
export const ADMIN_REASON_MAX_LENGTH = 500;
/** Why: 10..500 characters after trimming (the design's "10+ characters"; CLI max 500). */
export const AdminReasonSchema = visibleText(ADMIN_REASON_MIN_LENGTH, ADMIN_REASON_MAX_LENGTH);

export const ADMIN_NOTE_MAX_LENGTH = 1000;
/** A note on an order or a user (`AuditLog.after.text`, D-63 (9)). */
export const AdminNoteTextSchema = visibleText(1, ADMIN_NOTE_MAX_LENGTH);

/** Free-text search of an admin list (`q`). */
export const AdminSearchSchema = z.string().trim().min(1).max(64).regex(NO_CONTROL_CHARS);

/** The admin's answer to a step-up challenge: the id from `POST /admin/confirmations` + the code. */
export const AdminOtpAnswerSchema = z.strictObject({
  challengeId: z.string().regex(/^[0-9a-f]{32}$/),
  code: z.string().regex(/^\d{6}$/),
});
export type AdminOtpAnswer = z.infer<typeof AdminOtpAnswerSchema>;

/**
 * Step-up fields of a money action (D-46, D-63 (4)): above `ADMIN_CONFIRM_THRESHOLD_TIYIN` the
 * amount is re-typed AND the code is given; at or below it both may be left out. A code that is
 * given is checked even below the threshold.
 */
export const adminConfirmationShape = {
  confirmAmountTiyin: TiyinStringSchema.optional(),
  otp: AdminOtpAnswerSchema.optional(),
} as const;
export const AdminConfirmationSchema = z.strictObject(adminConfirmationShape);
export type AdminConfirmation = z.infer<typeof AdminConfirmationSchema>;

/** The same for a signed amount (wallet adjustment). */
export const adminSignedConfirmationShape = {
  confirmAmountTiyin: SignedTiyinStringSchema.optional(),
  otp: AdminOtpAnswerSchema.optional(),
} as const;

/** `:id` of every admin route. */
export const AdminIdParamsSchema = z.strictObject({ id: ResourceIdSchema });
export type AdminIdParams = z.infer<typeof AdminIdParamsSchema>;

/** Body of an action that needs only a reason (block, unblock, freeze, retry, ...). */
export const AdminReasonBodySchema = z.strictObject({ reason: AdminReasonSchema });
export type AdminReasonBody = z.infer<typeof AdminReasonBodySchema>;

/** Body of an add-a-note action. */
export const AdminNoteBodySchema = z.strictObject({ text: AdminNoteTextSchema });
export type AdminNoteBody = z.infer<typeof AdminNoteBodySchema>;

/**
 * Every admin write answers with the audit row it wrote and whether this call wrote it: a replay
 * with the same `Idempotency-Key` returns the first result with `applied: false`.
 */
export const adminActionResultShape = {
  auditId: ResourceIdSchema,
  applied: z.boolean(),
} as const;

/**
 * A state action (block, card pause, ...) on something already in the asked state writes nothing:
 * `applied: false`, `auditId: null` (the owner CLI's rule). A replay of a call that did write
 * returns that call's `auditId`.
 */
export const adminStateResultShape = {
  auditId: ResourceIdSchema.nullable(),
  applied: z.boolean(),
} as const;

/** A note as shown on an order or a user. */
export const AdminNoteSchema = z.strictObject({
  id: ResourceIdSchema,
  text: z.string(),
  createdAt: IsoDateTimeSchema,
  author: z.strictObject({ id: ResourceIdSchema, name: z.string() }),
});
export type AdminNote = z.infer<typeof AdminNoteSchema>;

export const AdminNoteResponseSchema = z.strictObject({
  note: AdminNoteSchema,
  ...adminActionResultShape,
});
export type AdminNoteResponse = z.infer<typeof AdminNoteResponseSchema>;
