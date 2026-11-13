// POST /quotes (docs/04 "Qabul qiluvchi va kotirovka") and the recipient token record that
// carries a validated recipient from /recipients/validate (phase 5) to the quote. The quote
// response never contains cost, maxCost or snapshot ids: those stay server-side.
import { z } from 'zod';
import { NO_CONTROL_CHARS, ResourceIdSchema } from '../common-schemas';
import { TiyinStringSchema } from '../money-schemas';

// Telegram usernames: 5-32 chars, letters/digits/underscore, start with a letter. Stored
// without the leading "@".
export const TG_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
// 32 random bytes as unpadded base64url.
export const RECIPIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INT32_MAX = 2_147_483_647;

// The display name comes from a third party (Fragment, a supplier) and is shown to customers and
// sent in bot messages. Refused (audit L3, owner decisions R6 and D-59 Y8, audit R4-2): control
// characters (Cc), every format character (Cf: the bidi marks, embeddings, overrides and isolates,
// the zero-width space, the word joiner and invisible operators, the soft hyphen, the BOM, the
// interlinear annotation marks, the shorthand and hieroglyph format controls, the language tag...)
// and the line and paragraph separators U+2028-2029. Deliberately NOT refused, though they are Cf:
// the zero-width joiner U+200D and non-joiner U+200C (compound emoji and several scripts need them)
// and the tag characters U+E0020-E007F (the flag emoji of England, Scotland and Wales are a black
// flag followed by tags). Written as an alternation, not one character class, because a class
// holding a joiner is read as one sequence by the linter and by some engines. The name is never
// altered, only refused. Built from a string with escapes on purpose: the invisible characters
// must never appear literally in this source file.
export const NO_INVISIBLE_CHARS = new RegExp(
  String.raw`^(?:[^\p{Cc}\p{Cf}\u2028\u2029]|\u200C|\u200D|[\u{E0020}-\u{E007F}])*$`,
  'u',
);

// A name must show at least one character a person can see (D-59 Y8, audit R4-2), defined
// positively: a letter, digit, punctuation mark or symbol, other than the Hangul and halfwidth
// fillers (U+3164, U+115F, U+1160, U+FFA0, letters that render as blanks) and the Braille blank
// U+2800 (a symbol that draws an empty cell). Spaces, joiners, combining marks, variation selectors
// (including the Mongolian ones) and tag characters alone are not a name: they look empty on a
// confirmation screen.
export const VISIBLE_CHAR = new RegExp(
  String.raw`(?![\u3164\u115F\u1160\uFFA0\u2800])[\p{L}\p{N}\p{P}\p{S}]`,
  'u',
);

export const RecipientSchema = z.strictObject({
  username: z.string().regex(TG_USERNAME_PATTERN),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(NO_INVISIBLE_CHARS)
    .refine((name) => VISIBLE_CHAR.test(name), {
      message: 'a name needs at least one visible character',
    }),
  photoUrl: z.httpUrl().max(512).optional(),
});
export type Recipient = z.infer<typeof RecipientSchema>;

/**
 * The provider's own handle of a validated recipient (Fragment's `recipient` value, a supplier's
 * player token). Opaque and INTERNAL: never in a response, never in a log; fulfillment compares
 * it again before paying (plan Q21).
 */
export const RecipientProviderRefSchema = z.string().min(1).max(256).regex(NO_CONTROL_CHARS);

/** What the token store keeps in Redis under the hash of the token. */
export const RecipientTokenRecordSchema = z.strictObject({
  userId: ResourceIdSchema,
  productId: ResourceIdSchema,
  recipient: RecipientSchema,
  // REQUIRED (audit L4): a recipient without the provider handle cannot be re-checked before
  // paying, so a token without one is never issued. Internal, see above.
  providerRef: RecipientProviderRefSchema,
  issuedAt: z.iso.datetime(),
});
export type RecipientTokenRecord = z.infer<typeof RecipientTokenRecordSchema>;

export const CreateQuoteBodySchema = z
  .strictObject({
    productId: ResourceIdSchema,
    skuId: ResourceIdSchema.optional(),
    quantity: z.number().int().positive().max(INT32_MAX).optional(),
    recipientToken: z.string().regex(RECIPIENT_TOKEN_PATTERN),
    discountCode: z.string().trim().min(1).max(64).regex(NO_CONTROL_CHARS).optional(),
  })
  .refine(({ skuId, quantity }) => (skuId === undefined) !== (quantity === undefined), {
    message: 'provide exactly one of skuId or quantity',
    path: ['quantity'],
  });
export type CreateQuoteBody = z.infer<typeof CreateQuoteBodySchema>;

export const QuoteResponseSchema = z.object({
  quoteId: z.string().min(1),
  priceTiyin: TiyinStringSchema,
  discountTiyin: TiyinStringSchema,
  totalTiyin: TiyinStringSchema,
  expiresAt: z.iso.datetime(),
  recipient: RecipientSchema.pick({ username: true, displayName: true }),
  currency: z.literal('UZS'),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
