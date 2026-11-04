// POST /quotes (docs/04 "Qabul qiluvchi va kotirovka") and the recipient token record that
// carries a validated recipient from /recipients/validate (phase 5) to the quote. The quote
// response never contains cost, maxCost or snapshot ids: those stay server-side.
import { z } from 'zod';
import { TiyinStringSchema } from '../money-schemas';

// Telegram usernames: 5-32 chars, letters/digits/underscore, start with a letter. Stored
// without the leading "@".
export const TG_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
// 32 random bytes as unpadded base64url.
export const RECIPIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INT32_MAX = 2_147_483_647;

// Row ids are Prisma cuid(2) (lowercase letters and digits). The allowed set is a little wider
// on purpose (fixtures use `prod_1`, `no-such-product`) but has no control characters: a NUL
// byte reaches Postgres as an invalid text value and would answer 500 instead of a clean 400.
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const IdSchema = z.string().min(1).max(64).regex(ID_PATTERN);

// Free text typed by a customer: no control characters (NUL, newline, tab, DEL) for the same
// reason. \P{Cc} is "any character that is not a control character".
const NO_CONTROL_CHARS = /^\P{Cc}*$/u;

export const RecipientSchema = z.strictObject({
  username: z.string().regex(TG_USERNAME_PATTERN),
  displayName: z.string().trim().min(1).max(128),
  photoUrl: z.httpUrl().max(512).optional(),
});
export type Recipient = z.infer<typeof RecipientSchema>;

/** What the token store keeps in Redis under the hash of the token. */
export const RecipientTokenRecordSchema = z.strictObject({
  userId: IdSchema,
  productId: IdSchema,
  recipient: RecipientSchema,
  issuedAt: z.iso.datetime(),
});
export type RecipientTokenRecord = z.infer<typeof RecipientTokenRecordSchema>;

export const CreateQuoteBodySchema = z
  .strictObject({
    productId: IdSchema,
    skuId: IdSchema.optional(),
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
