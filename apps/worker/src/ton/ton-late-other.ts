import type { Tx } from '@repo/db';
import {
  NOTHING,
  addFactOnce,
  lockTransferRow,
  type LateRows,
  type LateWrite,
} from './ton-late-rows';
import { lockAttempt } from './ton-row-locks';

/** OTHER_TRANSFER: the transfer whose message the hinted transaction carries, and that transaction. */
export interface OtherTransfer {
  readonly transferId: string;
  readonly txHash: string;
  readonly lt: string;
}

/**
 * S9f CR M2 (owner decision 3, 2026-11-18): the owner's Z6 hint for a CONSUMED_UNMATCHED transfer
 * named a transaction that the PRIMARY source lists as our wallet's, started by the signed message of
 * ANOTHER transfer of the same order (OTHER_TRANSFER). That other message reached the chain, so the
 * other transfer is no longer "provably not sent", whatever the late scan's 72 h window saw: it gets
 * a `late` fact on its own attempt (outcome OTHER_TRANSFER, via HINT), written once. Every guard that
 * reads late facts then counts it as paid: bindProof / closeAroundTransfer and TON_NOT_SENT
 * (LIVE_PAYOUT), assertNoLivePayout (every automatic refund, hold, cancel), the HELD sweep, the M-1
 * sign gate and `order:show`. Only the owner may go past it (decision 3: a proof bound to THAT
 * transfer, or MANUAL). A wrong mark can only stop a refund (fail closed), which is why the primary
 * source suffices here, unlike HINT_ACCEPTED, which moves a row to CONFIRMED and needs every witness.
 *
 * Only an EXPIRED or CONSUMED_UNMATCHED transfer is marked: any other status already counts as "may
 * have gone out". Locks: the caller holds the order (then the hinted transfer's attempt and row);
 * this takes the other attempt, then its transfer. Every writer of these rows locks the order first,
 * so the extra locks cannot deadlock against one that keeps docs/06 "Qulf tartibi".
 */
export async function markOtherTransfer(
  tx: Tx,
  rows: LateRows,
  other: OtherTransfer,
  auditId: string,
): Promise<LateWrite> {
  if (rows.orderId === null || other.transferId === rows.transferId) return NOTHING;
  const head = await tx.tonTransfer.findUnique({
    where: { id: other.transferId },
    select: { attemptId: true, attempt: { select: { orderId: true } } },
  });
  const attemptId = head?.attemptId ?? null;
  if (attemptId === null || head?.attempt?.orderId !== rows.orderId) return NOTHING;
  const attempt = await lockAttempt(tx, attemptId);
  const transfer = await lockTransferRow(tx, other.transferId);
  if (attempt === null || transfer === null) return NOTHING;
  if (transfer.status !== 'EXPIRED' && transfer.status !== 'CONSUMED_UNMATCHED') return NOTHING;
  const otherRows: LateRows = {
    transferId: other.transferId,
    transfer,
    orderId: rows.orderId,
    order: rows.order,
    attemptId,
    attempt,
  };
  return addFactOnce(tx, otherRows, 'late', {
    from: transfer.status,
    outcome: 'OTHER_TRANSFER',
    via: 'HINT',
    auditId,
    hintedTransferId: rows.transferId,
    txHash: other.txHash,
    txLt: other.lt,
  });
}
