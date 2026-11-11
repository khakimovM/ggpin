import type { Tx } from '../ledger/ledger.js';

/**
 * Base amounts counted by the 24 h top-up caps (`checkDailyTopupLimit`, @repo/shared) since
 * `since`:
 * - PAID intents by `paidAt` and PENDING ones by `createdAt`, at their BASE amount. EXPIRED and
 *   CANCELLED never count.
 * - Money the owner credited from a review WITHOUT an intent (D-54: `review:credit --user`; a
 *   Payment with `intentId` NULL), by `confirmedAt`, at its full amount (there is no base). It
 *   counts even if it was reversed later, like a PAID intent whose top-up was reversed. A
 *   credit WITH an intent is already counted through that PAID intent, so it is not added twice.
 * - NOT counted: `wallet:adjust` (an ADJUSTMENT ledger entry is a correction, not a top-up, and
 *   has no Payment row).
 * ONE query for the API (creating a request, the review:credit preview and its locked re-check)
 * and the worker (crediting one, which passes that intent as `excludeIntentId` so it is not
 * counted twice: its own base is the request).
 */
export async function usedTopupBaseSince(
  db: Tx,
  userId: string,
  since: Date,
  excludeIntentId?: string,
): Promise<bigint> {
  const intents = await db.paymentIntent.aggregate({
    where: {
      userId,
      provider: 'P2P_CARD',
      ...(excludeIntentId === undefined ? {} : { id: { not: excludeIntentId } }),
      OR: [
        { status: 'PAID', paidAt: { gte: since } },
        { status: 'PENDING', createdAt: { gte: since } },
      ],
    },
    _sum: { baseAmountTiyin: true },
  });
  const manual = await db.payment.aggregate({
    where: {
      userId,
      provider: 'P2P_CARD',
      intentId: null,
      status: { in: ['CONFIRMED', 'CANCELLED'] }, // CANCELLED: reversed after it was credited
      confirmedAt: { gte: since },
    },
    _sum: { amountTiyin: true },
  });
  return (intents._sum.baseAmountTiyin ?? 0n) + (manual._sum.amountTiyin ?? 0n);
}
