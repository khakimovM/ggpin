import { hasLateTonFact } from '@repo/db';
import type { OrderAttemptRow } from '../modules/orders/admin/order-admin.repository';
import { tonFact } from './order-late-facts';

const UNTIL_A1 = 'it stays NEEDS_REVIEW until A1 (before mainnet)';

/** The `late` outcomes that say the message PAID / reached the chain (CR M1, M2). */
const PAID_LATE_OUTCOMES: readonly unknown[] = ['CONFIRMED', 'SEQNO_HELD', 'OTHER_TRANSFER'];

/**
 * The line `order:show` prints when no honest proof can close a NEEDS_REVIEW order (phase 5 S9f,
 * owner 2026-11-18, option B), or null. The order stays NEEDS_REVIEW (no money moves); the way out
 * is due before mainnet on the A1 list (S9i / pre-mainnet: the migration CU -> EXPIRED and the
 * owner's MANUAL DELIVERED with OTP; it must cover shape 2 too). Ids only. Two shapes:
 *
 * 1. A CONSUMED_UNMATCHED transfer beside another transfer whose attempt holds a late chain fact
 *    (typically T1 EXPIRED with `late` SEQNO_HELD / OTHER_TRANSFER and T2 consumed-unmatched on
 *    the same seqno): TON_UNMATCHED_RESOLVED for the CU one needs every other transfer provably not
 *    sent; MANUAL FAILED needs every transfer EXPIRED, MANUAL DELIVERED none consumed-unmatched;
 *    the late one cannot become CONFIRMED while the CU one holds its seqno, and its attempt is
 *    FAILED, so no TON_TX binds either.
 * 2. (CR M1) A transfer the chain showed PAID late (CONFIRMED late, or a `late` SEQNO_HELD /
 *    OTHER_TRANSFER) beside an open attempt with no transfer and no reference (the M-1 sign gate
 *    stopped it: EARLIER_PAYOUT_LIVE, or a HELD release that met the gate): TON_TX and
 *    FRAGMENT_STATUS bind only the paid transfer's own attempt, which is FAILED (MISMATCH);
 *    MANUAL DELIVERED cannot close an attempt without a reference (MISMATCH); MANUAL FAILED is
 *    LIVE_PAYOUT beside a CONFIRMED transfer, and beside an EXPIRED paid one it would refund money
 *    that went out (the owner's call, never an honest proof).
 */
export function deadEndOf(
  orderStatus: string,
  attempts: readonly OrderAttemptRow[],
): string | null {
  if (orderStatus !== 'NEEDS_REVIEW') return null;
  const transfers = attempts.flatMap((a) =>
    a.tonTransfer === null
      ? []
      : [
          {
            id: a.tonTransfer.id,
            status: a.tonTransfer.status,
            late: hasLateTonFact(a.response),
            paidLate: PAID_LATE_OUTCOMES.includes(tonFact(a.response, 'late')?.('outcome')),
          },
        ],
  );
  for (const cu of transfers) {
    if (cu.status !== 'CONSUMED_UNMATCHED') continue;
    const late = transfers.find((t) => t.late && t.id !== cu.id);
    if (late !== undefined) {
      return `no proof can close this order: transfer ${late.id} carries a late chain fact while ${cu.id} is CONSUMED_UNMATCHED; ${UNTIL_A1}`;
    }
  }
  const paid = transfers.find((t) => t.paidLate);
  const bare = attempts.find(
    (a) =>
      (a.status === 'SENDING' || a.status === 'SENT' || a.status === 'UNKNOWN') &&
      a.tonTransfer === null &&
      a.externalRef === null,
  );
  if (paid !== undefined && bare !== undefined) {
    return `no proof can close this order: transfer ${paid.id} was found paid on the chain late while attempt ${bare.id} has no transfer and no reference; ${UNTIL_A1}`;
  }
  return null;
}
