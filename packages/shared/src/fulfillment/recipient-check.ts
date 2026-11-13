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
import { ResourceIdSchema } from '../common-schemas';
import { ValidateRecipientBodySchema } from '../orders/order-schemas';
import { RecipientProviderRefSchema, RecipientSchema } from '../pricing/quote-schemas';

/**
 * How long the API waits for the worker's answer before it says
 * `503 RECIPIENT_CHECK_UNAVAILABLE` (docs/04: "~10 soniya"). Also bounds the supplier call.
 */
export const RECIPIENT_CHECK_TIMEOUT_MS = 10_000;

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
