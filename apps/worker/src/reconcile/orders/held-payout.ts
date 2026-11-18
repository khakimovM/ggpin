import { hasLateTonFact, type Tx } from '@repo/db';

// What the order's own payout rows say before the HELD step releases or refunds it (phase 5 S9f,
// audit M-1 and L-1, held part). A HELD order normally carries no TON transfer at all, or only
// EXPIRED ones (the hold itself was refused while a payout was live). Two things make both of the
// step's moves wrong:
// - a late chain fact (`late` / `lateDestination` on an attempt, written by the TON module): the
//   chain showed one of the order's messages after all, so "not sent" is false. A release would
//   start a run that the signing gate stops anyway (M-1), a refund would pay the customer back for
//   value that left the company (L-1): neither, the owner is told;
// - a transfer that is not EXPIRED (signed, broadcast, confirmed, consumed, failed on chain,
//   bounced): only reachable with the guards bypassed; never released, never refunded.
// Read twice: by the decision (no write) and again inside the refund / release transaction, after
// the move has locked the order row (the TON module's late writes lock the order row first too), so
// a fact committed between the decision and the write is seen and the whole move rolls back.

export type HeldPayout = 'clean' | 'lateFact' | 'liveTransfer';

/** The two models read; a transaction client or the plain client both have them. */
export type HeldPayoutDb = Pick<Tx, 'fulfillmentAttempt' | 'tonTransfer'>;

/** The order's attempts and transfers, judged: a late fact first (it explains a live transfer). */
export async function heldPayoutOf(db: HeldPayoutDb, orderId: string): Promise<HeldPayout> {
  const [attempts, transfers] = await Promise.all([
    db.fulfillmentAttempt.findMany({ where: { orderId }, select: { response: true } }),
    db.tonTransfer.findMany({ where: { attempt: { orderId } }, select: { status: true } }),
  ]);
  if (attempts.some((attempt) => hasLateTonFact(attempt.response))) return 'lateFact';
  return transfers.every((transfer) => transfer.status === 'EXPIRED') ? 'clean' : 'liveTransfer';
}

/** The order's payout rows changed under the HELD step's move: nothing was written. */
export class HeldPayoutError extends Error {
  constructor(
    readonly orderId: string,
    readonly why: Exclude<HeldPayout, 'clean'>,
  ) {
    super(`order ${orderId}: ${why} under a HELD move, rolled back`);
    this.name = 'HeldPayoutError';
  }
}

/** Inside the move's transaction (the order row already locked by it): refuse unless clean. */
export async function assertHeldPayoutClean(tx: HeldPayoutDb, orderId: string): Promise<void> {
  const payout = await heldPayoutOf(tx, orderId);
  if (payout !== 'clean') throw new HeldPayoutError(orderId, payout);
}
