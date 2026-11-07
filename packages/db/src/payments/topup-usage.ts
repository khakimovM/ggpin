import type { Tx } from '../ledger/ledger.js';

/**
 * Base amounts counted by the 24 h top-up caps (`checkDailyTopupLimit`, @repo/shared): PAID
 * intents by `paidAt`, PENDING ones by `createdAt`, since `since`. EXPIRED and CANCELLED never
 * count. ONE query for the API (creating a request) and the worker (crediting one, which passes
 * that intent as `excludeIntentId` so it is not counted twice: its own base is the request).
 */
export async function usedTopupBaseSince(
  db: Tx,
  userId: string,
  since: Date,
  excludeIntentId?: string,
): Promise<bigint> {
  const { _sum } = await db.paymentIntent.aggregate({
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
  return _sum.baseAmountTiyin ?? 0n;
}
