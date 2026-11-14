// Job contract of the `validate-recipient` queue (QUEUES.VALIDATE_RECIPIENT): the API asks the
// worker (the only process that can reach Fragment or a supplier) who a recipient is and waits
// for the answer; docs/04 `POST /recipients/validate`. The job holds no user id: it is a pure
// question about a product and an input, so a job can never be replayed against another user.
//
// Privacy: the input (a Telegram username, a player id) and the answer's display name are
// personal data. They stay out of logs and the job result is short-lived (VALIDATE_RECIPIENT
// retention, queues.ts). The display name is untrusted text from a third party: the bot
// escapes it before it reaches an HTML message, and no photo URL is passed on in phase 5 (Q12).
import { z } from 'zod';
import type { ProductInput } from '../catalog/input-schema';
import { ResourceIdSchema } from '../common-schemas';
import { ValidateRecipientBodySchema } from '../orders/order-schemas';
import {
  RecipientProviderRefSchema,
  RecipientSchema,
  TG_USERNAME_PATTERN,
} from '../pricing/quote-schemas';

/**
 * How long the API waits for the worker's answer before it says
 * `503 RECIPIENT_CHECK_UNAVAILABLE` (docs/04: "~10 soniya"). Also bounds the supplier call.
 */
export const RECIPIENT_CHECK_TIMEOUT_MS = 10_000;

/** BullMQ job name on QUEUES.VALIDATE_RECIPIENT (producer and consumer share it). */
export const RECIPIENT_CHECK_JOB_NAME = 'validate-recipient';

/**
 * How long one answer serves every identical question (same product, same normalized input).
 * The API's job id carries the time bucket of this width, so a lookup is reused only inside its
 * own bucket: an answer is never older than this when it is used, and a burst of identical
 * questions (two users, a double tap) costs the provider one lookup.
 */
export const RECIPIENT_CHECK_REUSE_MS = 60_000;
// How long a finished job is kept: RECIPIENT_CHECK_RETENTION_SEC (queues.ts, next to the queue's
// other defaults).

/** What the API puts on the queue: the product and the typed input, validated against its `inputSchema`. */
export const RecipientCheckRequestSchema = z.strictObject({
  productId: ResourceIdSchema,
  input: ValidateRecipientBodySchema.shape.input,
});
export type RecipientCheckRequest = z.infer<typeof RecipientCheckRequestSchema>;

/**
 * What the worker answers. `UNAVAILABLE` = the adapter could not tell (session dead, provider
 * down): the API answers 503, never "not found", so an outage cannot look like a missing user.
 * `FOUND.providerRef` is the provider's own handle of the recipient (Fragment's `recipient`
 * value). It is INTERNAL: it never reaches the client, it rides the recipient token and the
 * quote so fulfillment can check that the same recipient is still there (Q21).
 */
export const RecipientCheckResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('FOUND'),
    providerRef: RecipientProviderRefSchema,
    displayName: RecipientSchema.shape.displayName,
  }),
  z.strictObject({ status: z.literal('NOT_FOUND') }),
  z.strictObject({ status: z.literal('UNAVAILABLE') }),
]);
export type RecipientCheckResult = z.infer<typeof RecipientCheckResultSchema>;

/**
 * The one canonical form of a Telegram username (API job id and token, worker lookup): spaces
 * around it and one leading `@` are dropped, and it is lower-cased because Telegram usernames are
 * case-insensitive (`@Aziz_K` and `aziz_k` are one person, one lookup, one cached answer).
 * Null when what is left is not a username (5-32 characters, letters, digits and `_`, starting
 * with a letter). Normalizing a normalized value returns it unchanged.
 */
export function normalizeTgUsername(raw: string): string | null {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return TG_USERNAME_PATTERN.test(bare) ? bare.toLowerCase() : null;
}

/** Why one input field was refused: the path and a Zod-like code, never the value (docs/04). */
export interface RecipientInputIssue {
  readonly path: string;
  readonly code: 'invalid_type' | 'unrecognized_keys' | 'invalid_format';
}

export type NormalizedRecipientInput =
  | { readonly ok: true; readonly input: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly issues: readonly RecipientInputIssue[] };

/**
 * Checks a client's `input` against a product's `inputSchema` and returns it in canonical form:
 * every field present, no other key, each value valid for its field type and normalized. Own
 * keys only, so a key such as `constructor` is an unknown key, never an inherited value.
 */
export function normalizeRecipientInput(
  fields: ProductInput,
  input: Readonly<Record<string, string>>,
): NormalizedRecipientInput {
  const issues: RecipientInputIssue[] = [];
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) issues.push({ path: `input.${key}`, code: 'unrecognized_keys' });
  }
  const normalized: [string, string][] = [];
  for (const field of fields) {
    const raw = Object.hasOwn(input, field.key) ? input[field.key] : undefined;
    if (raw === undefined) {
      // Zod's code for a missing key (docs/04: details.fields carries Zod issue codes).
      issues.push({ path: `input.${field.key}`, code: 'invalid_type' });
      continue;
    }
    const value = normalizeFieldValue(field.type, raw);
    if (value === null) issues.push({ path: `input.${field.key}`, code: 'invalid_format' });
    else normalized.push([field.key, value]);
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, input: Object.fromEntries(normalized) };
}

function normalizeFieldValue(type: ProductInput[number]['type'], raw: string): string | null {
  switch (type) {
    case 'tgUsername':
      return normalizeTgUsername(raw);
  }
}
