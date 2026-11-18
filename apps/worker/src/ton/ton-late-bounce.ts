import { transitionOrder, type AttemptStatus, type OrderStatus, type Tx } from '@repo/db';
import { withTonFacts } from './ton-row-locks';
import { earlierLivePayout } from './ton-sign-guards';
import type { OurTxFacts, ReturnTxFacts } from './ton-tx-facts';
import {
  NOTHING,
  WRITTEN,
  addFactOnce,
  txFacts,
  type LateRows,
  type LateWrite,
} from './ton-late-rows';

// A late bounce (phase 5 S9f): the destination of a CONFIRMED transfer sent the value back after
// the transfer was decided. BOUNCED (S5's shape: the `bounce` facts the owner's TON_BOUNCED proof
// needs, the attempt UNKNOWN, PROCESSING -> NEEDS_REVIEW) only while that is the order's one live
// payout (`lateBounceMode`, review F1, audit L-2); otherwise, and for a returned amount outside
// what TON_BOUNCED accepts (F4), the transfer stays CONFIRMED and the facts go to `lateBounce`
// (written once). Runs on rows TonLateRepository has locked (order -> attempt -> transfer).

export type ReturnOutOfRange = 'RETURN_ABOVE_SENT' | 'RETURN_BELOW_FLOOR';

export interface LateBounce {
  readonly kind: 'LATE_BOUNCE';
  readonly tx: OurTxFacts;
  readonly returnTx: ReturnTxFacts;
  /** The returned amount is outside what TON_BOUNCED accepts: facts only. */
  readonly outOfRange: ReturnOutOfRange | null;
}

const OPEN_ATTEMPT: readonly AttemptStatus[] = ['SENDING', 'SENT', 'UNKNOWN'];

/**
 * BOUNCED needs: the order PROCESSING / NEEDS_REVIEW (the database guard refuses BOUNCED
 * otherwise), the transfer's own attempt open (an EXPIRED-then-found transfer's attempt is FAILED:
 * a dead attempt never takes the order back), every other transfer of the order provably not sent,
 * and a returned amount TON_BOUNCED accepts. Anything else: facts only.
 */
export function lateBounceMode(input: {
  readonly orderStatus: OrderStatus | null;
  readonly attemptStatus: AttemptStatus | null;
  readonly othersQuiet: boolean;
  readonly outOfRange: boolean;
}): 'BOUNCED' | 'FACTS' {
  const reviewable = input.orderStatus === 'PROCESSING' || input.orderStatus === 'NEEDS_REVIEW';
  const open = input.attemptStatus !== null && OPEN_ATTEMPT.includes(input.attemptStatus);
  return reviewable && open && input.othersQuiet && !input.outOfRange ? 'BOUNCED' : 'FACTS';
}

/** The facts the owner's TON_BOUNCED proof reads (S5's `bounce` shape, money as strings). */
function bounceFacts(outcome: LateBounce) {
  return {
    ...txFacts(outcome.tx),
    returnTxHash: outcome.returnTx.hash,
    returnLt: outcome.returnTx.lt.toString(),
    returnedNanoTon: outcome.returnTx.returnedNano.toString(),
    destinationTxHash: outcome.returnTx.destTxHash,
  };
}

export async function bounceLate(tx: Tx, rows: LateRows, outcome: LateBounce): Promise<LateWrite> {
  const t = rows.transfer;
  // Only the transaction recorded on the transfer (its chain data is written once).
  if (t.status !== 'CONFIRMED' || t.txHash !== outcome.tx.hash || t.txLt !== outcome.tx.lt) {
    return NOTHING;
  }
  const order = rows.order?.status ?? null;
  const othersQuiet =
    rows.orderId === null ||
    rows.attemptId === null ||
    (await earlierLivePayout(tx, rows.orderId, rows.attemptId)) === null;
  const mode = lateBounceMode({
    orderStatus: order,
    attemptStatus: rows.attempt?.status ?? null,
    othersQuiet,
    outOfRange: outcome.outOfRange !== null,
  });
  if (mode === 'FACTS') {
    const detail = outcome.outOfRange === null ? {} : { detail: outcome.outOfRange };
    return addFactOnce(tx, rows, 'lateBounce', {
      ...bounceFacts(outcome),
      ...detail,
      orderStatus: order ?? 'NONE',
    });
  }
  // R4-1: the order row is locked (by the repository) before the BOUNCED update.
  await tx.tonTransfer.update({ where: { id: rows.transferId }, data: { status: 'BOUNCED' } });
  const attempt = rows.attempt;
  if (attempt !== null && rows.attemptId !== null) {
    const open = attempt.status === 'SENDING' || attempt.status === 'SENT';
    await tx.fulfillmentAttempt.update({
      where: { id: rows.attemptId },
      data: {
        ...(open ? { status: 'UNKNOWN' as const } : {}),
        response: withTonFacts(attempt.response, { bounce: bounceFacts(outcome) }),
      },
    });
  }
  if (order !== 'PROCESSING' || rows.orderId === null) return WRITTEN;
  await transitionOrder(tx, {
    orderId: rows.orderId,
    from: 'PROCESSING',
    to: 'NEEDS_REVIEW',
    actor: 'system',
    reason: 'ADAPTER_ERROR',
    note: `ton transfer ${rows.transferId} bounced late`,
  });
  return { written: true, reviewed: true };
}
