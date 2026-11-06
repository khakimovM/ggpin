import type { CardTotals } from './card-pool.repository';

// Asia/Tashkent has no daylight saving: a fixed UTC+5 (the bank and the owner think in it).
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Start of the current calendar month in Asia/Tashkent, as a UTC instant. */
export function tashkentMonthStart(now: Date): Date {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return new Date(startLocal - TASHKENT_OFFSET_MS);
}

/**
 * What the card may still receive (docs/05 §2): lifetime limit minus everything received since
 * verification minus the unpaid amounts still reserved; with a monthly cap also the same for
 * this month; the smaller one wins. Negative when the card is over its limit.
 */
export function freeCapacity(totals: CardTotals): bigint {
  const { card, receivedTiyin, receivedMonthTiyin, reservedTiyin } = totals;
  const lifetime = card.receiveLimitTiyin - receivedTiyin - reservedTiyin;
  if (card.monthlyLimitTiyin === null) return lifetime;
  const monthly = card.monthlyLimitTiyin - receivedMonthTiyin - reservedTiyin;
  return monthly < lifetime ? monthly : lifetime;
}

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

export interface HeldIntent {
  readonly status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  readonly expiresAt: Date;
  readonly reservedUntil: Date;
}

/**
 * Until when an intent counts against its card's capacity (D-42 (1)); null = never (PAID money
 * is counted as received). Every UNPAID one (PENDING, EXPIRED, CANCELLED) alike:
 * `LEAST(reservedUntil, expiresAt + hold)`, so a PENDING past its deadline that the sweep has
 * not expired yet stops counting when an EXPIRED one would. The amount's UNIQUENESS is not this: it lasts until
 * `reservedUntil` (EXCLUDE constraint, allocator). `CardPoolRepository.cardTotals` is the SQL
 * form of this rule (an intent counts while `now < capacityHoldEnd`).
 */
export function capacityHoldEnd(intent: HeldIntent, holdSec: number): Date | null {
  if (intent.status === 'PAID') return null;
  const holdEnd = intent.expiresAt.getTime() + holdSec * 1000;
  return new Date(Math.min(holdEnd, intent.reservedUntil.getTime()));
}

/**
 * D-42 (1) alert condition: the unpaid reserved share (PENDING + EXPIRED/CANCELLED inside the
 * hold window) is above half of what the card may still receive (the smaller of the lifetime and
 * the monthly remainder). A card with nothing left and anything reserved counts as high.
 */
export function reservedShareHigh(totals: CardTotals): boolean {
  const remainder = remainingLimit(totals);
  if (remainder <= 0n) return totals.reservedTiyin > 0n;
  return totals.reservedTiyin * 2n > remainder;
}

/**
 * The `percent` of the `cardReservedHigh` alert: the reserved share of the remaining limit,
 * rounded down to a whole number (a share, not money). Nothing left counts as 100.
 */
export function reservedSharePercent(totals: CardTotals): number {
  const remainder = remainingLimit(totals);
  if (remainder <= 0n) return 100;
  return Number((totals.reservedTiyin * 100n) / remainder);
}

/** What the card may still receive before reservations: the smaller of lifetime and month. */
function remainingLimit(totals: CardTotals): bigint {
  const { card, receivedTiyin, receivedMonthTiyin } = totals;
  const lifetime = card.receiveLimitTiyin - receivedTiyin;
  const monthly =
    card.monthlyLimitTiyin === null ? lifetime : card.monthlyLimitTiyin - receivedMonthTiyin;
  return monthly < lifetime ? monthly : lifetime;
}
