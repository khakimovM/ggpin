import { freeCapacity } from '@repo/shared';
import type { CardTotals } from './card-pool.repository';

// The capacity rules are shared with the worker (packages/shared/src/payments/card-capacity.ts,
// D-42 (1)); only the API's card ranking lives here. Re-exported so the card services keep one
// local import.
export {
  CARD_FULL_PERCENT,
  capacityHoldEnd,
  freeCapacity,
  receivedUsagePercent,
  reservedShareHigh,
  reservedSharePercent,
  tashkentMonthStart,
  type HeldIntent,
} from '@repo/shared';

/**
 * Preference order for a new request: the user's previous card first when it can take the
 * request (sticky, D-37 (3)), then by free capacity, largest first; id breaks ties so the order
 * is stable. Cards that cannot take `needTiyin` are dropped.
 */
export function rankCards(
  cards: readonly CardTotals[],
  needTiyin: bigint,
  stickyCardId: string | null,
): CardTotals[] {
  const usable = cards
    .map((totals) => ({ totals, free: freeCapacity(totals) }))
    .filter(({ free }) => free >= needTiyin);
  usable.sort((a, b) => {
    const aSticky = a.totals.card.id === stickyCardId;
    const bSticky = b.totals.card.id === stickyCardId;
    if (aSticky !== bSticky) return aSticky ? -1 : 1;
    if (a.free !== b.free) return a.free > b.free ? -1 : 1;
    return a.totals.card.id < b.totals.card.id ? -1 : a.totals.card.id > b.totals.card.id ? 1 : 0;
  });
  return usable.map(({ totals }) => totals);
}
