import { createHash } from 'node:crypto';
import {
  NeedsReviewProofSchema,
  proofJustifies,
  type NeedsReviewOutcome,
  type NeedsReviewProof,
} from '@repo/shared';
import { z } from 'zod';
import { validationError } from '../../../common/admin/admin-input';
import type { OrderAttemptRow } from './order-admin.repository';

// Pure rules of `order:resolve` (phase 5 S10): reading the proof, what the owner's code is bound
// to, and the two extra questions the CLI asks before @repo/db binds the proof under lock.

/**
 * The proof as typed. Its `reason` is the command's `--reason` (the audit row's reason is the
 * proof's): a proof without one gets it, one with a different one is refused, so the audit row
 * can never carry two stories. Shape, kind and exit are checked here for a clear refusal; @repo/db
 * checks all of it again in the transaction.
 */
export function parseProof(raw: unknown, reason: string, to: NeedsReviewOutcome): NeedsReviewProof {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw validationError('proof', 'INVALID');
  }
  const typed = raw as Record<string, unknown>;
  if (typed['reason'] !== undefined && typed['reason'] !== reason) {
    throw validationError('proof', 'REASON_DIFFERS');
  }
  const parsed = NeedsReviewProofSchema.safeParse({ ...typed, reason });
  if (!parsed.success) throw validationError('proof', 'INVALID');
  if (!proofJustifies(parsed.data, to)) throw validationError('proof', 'WRONG_KIND');
  return parsed.data;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** 12 hex of sha256 over the proof with sorted keys: the code confirms exactly this proof. */
export function proofDigest(proof: NeedsReviewProof): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(proof)))
    .digest('hex')
    .slice(0, 12);
}

/**
 * What the owner's code for `order:resolve` names: ids, the exit, the proof kind (with the finding
 * of a TON_UNMATCHED_RESOLVED proof, so the bot message says whether the wallet is called
 * compromised: audit I-1) and the digest.
 */
export function resolveOtpTarget(
  orderId: string,
  to: NeedsReviewOutcome,
  proof: NeedsReviewProof,
): string {
  const kind =
    proof.kind === 'TON_UNMATCHED_RESOLVED' ? `${proof.kind} ${proof.finding}` : proof.kind;
  return `order ${orderId} ${to} ${kind} ${proofDigest(proof)}`;
}

export const OUTSIDE_SYSTEM_FLAG = 'delivered-outside-system';

const UNRESOLVED = ['SENDING', 'SENT', 'UNKNOWN'];

/** A transfer in these states never left the wallet (docs/06 Z3). */
const NOT_SENT = ['EXPIRED', 'ONCHAIN_FAILED'];

/**
 * I-8 (docs/06 Z3, CR m6): a MANUAL delivery while an attempt it closes has a TON transfer of its
 * own that never left the wallet (EXPIRED, or ONCHAIN_FAILED). The owner must say they delivered
 * outside the system. An attempt without a transfer (a future supplier attempt, or one that died
 * before signing) does not raise it: nothing says the TON did not leave.
 */
export function deliversOutsideSystem(
  to: NeedsReviewOutcome,
  proof: NeedsReviewProof,
  attempts: readonly Pick<OrderAttemptRow, 'status' | 'tonTransfer'>[],
): boolean {
  if (to !== 'DELIVERED' || proof.kind !== 'MANUAL') return false;
  return attempts.some(
    (a) => UNRESOLVED.includes(a.status) && NOT_SENT.includes(a.tonTransfer?.status ?? ''),
  );
}

/** The bounce the TON module recorded on the attempt (`response.ton.bounce`, S5). */
export const StoredBounceSchema = z.object({
  ton: z.object({
    bounce: z.object({
      txHash: z.string(),
      txLt: z.string(),
      returnTxHash: z.string(),
      returnLt: z.string(),
      returnedNanoTon: z.string(),
    }),
  }),
});
export type StoredBounce = z.infer<typeof StoredBounceSchema>['ton']['bounce'];

export function storedBounce(response: unknown): StoredBounce | null {
  const parsed = StoredBounceSchema.safeParse(response);
  return parsed.success ? parsed.data.ton.bounce : null;
}

/**
 * A TON_BOUNCED proof must name the bounce the TON module itself saw on the chain (two sources,
 * S5): the API cannot read the chain, so a return hash, time or amount the worker did not record
 * is refused here (`BOUNCE_FACTS_MISMATCH`), and @repo/db then binds the rest to the transfer.
 */
export function assertBounceRecorded(
  proof: NeedsReviewProof,
  attempts: readonly Pick<OrderAttemptRow, 'response' | 'tonTransfer'>[],
): void {
  if (proof.kind !== 'TON_BOUNCED') return;
  const attempt = attempts.find((a) => a.tonTransfer?.id === proof.transferId);
  const seen = attempt === undefined ? null : storedBounce(attempt.response);
  if (
    seen === null ||
    seen.txHash !== proof.txHash ||
    seen.txLt !== proof.txLt ||
    seen.returnTxHash !== proof.returnTxHash ||
    seen.returnLt !== proof.returnLt ||
    seen.returnedNanoTon !== proof.returnedNanoTon
  ) {
    throw validationError('proof', 'BOUNCE_FACTS_MISMATCH');
  }
}
