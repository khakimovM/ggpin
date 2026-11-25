// Z6 hint (phase 5 S9, D-64 (7), Q-7): the owner names the transaction that may carry a
// CONSUMED_UNMATCHED transfer's message (`ton:hint <transferId> --tx --lt --reason`). The hint is
// an AuditLog row (append-only, no migration); the reconciler checks it on the primary source and
// at least one witness before it writes anything. A hint proves nothing by itself.
import { z } from 'zod';
import { TonHashSchema } from './address-format';

/** `AuditLog.action` of an owner's Z6 hint (`targetType "TonTransfer"`). */
export const TON_TX_HINT_ACTION = 'TON_TX_HINT';

// A TonTransfer id: Prisma cuid(2), lowercase letters and digits, starting with a letter.
const TRANSFER_ID_PATTERN = /^[a-z][0-9a-z]{19,31}$/;
// A transaction's logical time: a positive uint64 as a decimal string, no leading zero.
const POSITIVE_LT_PATTERN = /^[1-9]\d{0,19}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;

export const TonTxHintSchema = z.strictObject({
  /** The CONSUMED_UNMATCHED transfer the hint is about. */
  transferId: z.string().regex(TRANSFER_ID_PATTERN),
  /** The transaction hash: 64 lowercase hex digits (the one stored spelling). */
  txHash: TonHashSchema,
  /** Its logical time. */
  lt: z
    .string()
    .regex(POSITIVE_LT_PATTERN)
    // The pattern again: a refinement may run after a failed regex, and BigInt('x') throws.
    .refine((lt) => POSITIVE_LT_PATTERN.test(lt) && BigInt(lt) <= UINT64_MAX, {
      message: 'lt out of range',
    }),
});
export type TonTxHint = z.infer<typeof TonTxHintSchema>;
