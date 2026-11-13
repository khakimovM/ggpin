import type { NeedsReviewProof } from '@repo/shared';
import type { Tx } from '../ledger/ledger.js';
import { ReviewProofError } from './errors.js';

/**
 * The checks of a proof that need to QUERY (the binding itself is a pure function of the order's
 * rows): a hash that the proof says belongs to somebody else's transaction must not be one of OUR
 * outgoing transactions, and one bounce may pay out one refund.
 *
 * - TON_BOUNCED: `returnTxHash` is an INCOMING transaction (the bounce), so it cannot be the hash
 *   of any transfer we sent (a payout of another order passed off as a return); and no earlier
 *   resolution may have named it (audit R2e: one bounce refunding two orders). The partial unique
 *   index `AuditLog_review_return_tx_key` is the backstop for two resolutions racing.
 * - TON_UNMATCHED_RESOLVED: `consumingTxHash` is the UNKNOWN transaction that used the seqno, so it
 *   cannot be one of ours either: that would be a CONFIRMED transfer, not an unmatched seqno; and one
 *   finding pays one refund (Z5: `AuditLog_review_consuming_tx_key`, the same shape as the return one).
 */
export async function assertProofHashesFresh(
  tx: Tx,
  orderId: string,
  proof: NeedsReviewProof,
): Promise<void> {
  const foreign =
    proof.kind === 'TON_BOUNCED'
      ? proof.returnTxHash
      : proof.kind === 'TON_UNMATCHED_RESOLVED'
        ? proof.consumingTxHash
        : null;
  if (foreign !== null) {
    const ours = await tx.tonTransfer.findFirst({
      where: { txHash: foreign },
      select: { id: true },
    });
    if (ours !== null) throw new ReviewProofError('MISMATCH', orderId);
  }
  if (proof.kind === 'TON_BOUNCED') {
    const used = await tx.auditLog.findFirst({
      where: {
        action: 'ORDER_REVIEW_RESOLVE',
        after: { path: ['proof', 'returnTxHash'], equals: proof.returnTxHash },
      },
      select: { id: true },
    });
    if (used !== null) throw new ReviewProofError('RETURN_TX_REUSED', orderId);
  }
  if (proof.kind === 'TON_UNMATCHED_RESOLVED') {
    const used = await tx.auditLog.findFirst({
      where: {
        action: 'ORDER_REVIEW_RESOLVE',
        after: { path: ['proof', 'consumingTxHash'], equals: proof.consumingTxHash },
      },
      select: { id: true },
    });
    if (used !== null) throw new ReviewProofError('CONSUMING_TX_REUSED', orderId);
  }
}
