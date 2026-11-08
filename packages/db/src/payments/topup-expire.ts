import type { Tx } from '../ledger/ledger.js';

/** Which requests one expiry pass looks at: one user's, one request, or all (the worker sweep). */
export interface TopupExpireScope {
  readonly userId?: string;
  readonly id?: string;
}

/**
 * PENDING -> EXPIRED for every P2P request in `scope` whose deadline has passed: the ONE
 * definition of "overdue" (`expiresAt <= now`; a request is live while `now < expiresAt`, the
 * same half-open bound the pay view, the token rotation and cancel use). The API runs it before
 * every read and write of a user's requests, the worker's `topup-expire` sweep every minute
 * for all of them. Callers check the transition with `assertIntentTransition` first. A plain
 * conditional UPDATE: it never touches PAID, CANCELLED or an EXPIRED row, never moves
 * `reservedUntil` (the amount stays reserved through the grace window) and takes no card lock,
 * so it cannot deadlock with the allocator or the matcher. Returns how many it expired.
 */
export async function expireOverdueTopups(
  db: Tx,
  now: Date,
  scope: TopupExpireScope = {},
): Promise<number> {
  const { count } = await db.paymentIntent.updateMany({
    where: { ...scope, provider: 'P2P_CARD', status: 'PENDING', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  return count;
}
