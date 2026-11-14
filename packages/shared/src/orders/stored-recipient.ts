// Reading the recipient an order (copied from its quote) STORES, for the public `recipient`
// (review M2, audit I6). The input schema (RecipientSchema) checks what a client may send TODAY and
// may tighten later (a new name rule, a new field); a row written under an older rule must still
// be listed, opened and replayed. So reading is lenient: it takes only what the answer needs, each
// field on its own (one bad field never hides the other), and ignores every other key.
import { z } from 'zod';
import { NO_INVISIBLE_CHARS } from '../pricing/quote-schemas';
import type { OrderRecipient } from './order-schemas';

/**
 * What an order shows when its stored recipient has neither a usable name nor a username (review
 * M2, audit I6; one constant for the API mapper and its tests, review N1). An em dash: a sign, not
 * words, so there is nothing to translate.
 */
export const RECIPIENT_PLACEHOLDER = '—';

// The public limits of OrderRecipientSchema (`displayName`, a `fields` value): 1-128 characters,
// and the input rule's ban on invisible and bidi controls (audit I1): a row written before that
// rule, or by hand, must not reorder the text around it on a client. A bad field is dropped alone.
const StoredTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(NO_INVISIBLE_CHARS)
  .optional()
  .catch(undefined);

export const StoredRecipientSchema = z.object({
  username: StoredTextSchema,
  displayName: StoredTextSchema,
});

/**
 * The public `recipient` of a stored one: its name (else the username) and `{ username }`.
 * `null` when the row holds neither: the caller shows a placeholder and logs the order id.
 */
export function storedRecipientView(stored: unknown): OrderRecipient | null {
  const parsed = StoredRecipientSchema.safeParse(stored);
  if (!parsed.success) return null;
  const { username, displayName } = parsed.data;
  const shown = displayName ?? username;
  if (shown === undefined) return null;
  const fields: Record<string, string> = username === undefined ? {} : { username };
  // The limits above are the contract's own (OrderRecipientSchema) and `username` is a valid form
  // key, so the view always passes it, whatever the row held (stored-recipient.test.ts proves it).
  return { displayName: shown, fields };
}
