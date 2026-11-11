// Receiving-card capacity (docs/05 §2, D-42 (1), D-45): one set of pure rules for the API
// (allocator, card commands, the cardReservedHigh alert), the worker (80 % alert, ACTIVE -> FULL,
// the late payment over-limit alert) and the notify renderer (the `percent` of an alert). Held
// UNPAID amounts only reduce the room for NEW requests (`freeCapacity`); the card's state and the
// 80 / 100 % alerts follow money actually received (`receivedUsagePercent`, D-45). The SQL that
// produces the sums is `cardTotals` in @repo/db; its "reserved" predicate is built from
// `capacityHoldWindow` below, so both processes count the same intents.

/** The two limits of a card (`TopupCard`); both positive (CHECK). */
export interface CardLimits {
  readonly receiveLimitTiyin: bigint;
  readonly monthlyLimitTiyin: bigint | null;
}

/** A card with the three sums its capacity is computed from. */
export interface CardSums {
  readonly card: CardLimits;
  /** Every PARSED CREDIT on the card since `verifiedAt`, matched or not (the bank's view). PAID money is here. */
  readonly receivedTiyin: bigint;
  /** The same, since the start of the current month (Asia/Tashkent). */
  readonly receivedMonthTiyin: bigint;
  /** UNPAID amounts still held against the card (see `capacityHoldWindow`). */
  readonly reservedTiyin: bigint;
}

/** Owner warning at this share of the limit, received money only (docs/05 §2, D-45). */
export const CARD_NEAR_LIMIT_PERCENT = 80;
/** At this share of received money an ACTIVE card becomes FULL (D-45). */
export const CARD_FULL_PERCENT = 100;

/** Intent statuses whose amount is held against the card: every UNPAID one. PAID is received money. */
export const CAPACITY_HELD_STATUSES = ['PENDING', 'EXPIRED', 'CANCELLED'] as const;

/**
 * The D-42 (1) predicate as bounds: an UNPAID intent counts while
 * `reservedUntil > now AND expiresAt > now - holdSec`, i.e. until `capacityHoldEnd`.
 */
export function capacityHoldWindow(
  now: Date,
  holdSec: number,
): { readonly reservedUntilAfter: Date; readonly expiresAtAfter: Date } {
  return { reservedUntilAfter: now, expiresAtAfter: new Date(now.getTime() - holdSec * 1000) };
}

export interface HeldIntent {
  readonly status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  readonly expiresAt: Date;
  readonly reservedUntil: Date;
}

/**
 * Until when an intent counts against its card's capacity; null = never (PAID money is counted
 * as received). Every UNPAID one alike: `LEAST(reservedUntil, expiresAt + hold)`, so a PENDING
 * past its deadline that the sweep has not expired yet stops counting when an EXPIRED one would.
 * The amount's UNIQUENESS is not this: it lasts until `reservedUntil` (EXCLUDE constraint).
 */
export function capacityHoldEnd(intent: HeldIntent, holdSec: number): Date | null {
  if (intent.status === 'PAID') return null;
  const holdEnd = intent.expiresAt.getTime() + holdSec * 1000;
  return new Date(Math.min(holdEnd, intent.reservedUntil.getTime()));
}

/**
 * What the card may still receive: lifetime limit minus everything received since verification
 * minus the unpaid amounts still held; with a monthly cap also the same for this month; the
 * smaller one wins. Negative when the card is over its limit.
 */
export function freeCapacity(sums: CardSums): bigint {
  const { card, receivedTiyin, receivedMonthTiyin, reservedTiyin } = sums;
  const lifetime = card.receiveLimitTiyin - receivedTiyin - reservedTiyin;
  if (card.monthlyLimitTiyin === null) return lifetime;
  const monthly = card.monthlyLimitTiyin - receivedMonthTiyin - reservedTiyin;
  return monthly < lifetime ? monthly : lifetime;
}

/**
 * How full the card is with money that actually ARRIVED, in whole percent (rounded down): the
 * larger of the lifetime and the monthly share (D-45, changes D-37 (6)). Held UNPAID amounts are
 * left out on purpose: a create-and-cancel farm must not be able to keep a card FULL (the held
 * share has its own alert, `cardReservedHigh`). 80 raises `cardNearLimit`, 100 turns an ACTIVE
 * card FULL; below 100 a FULL card may become ACTIVE again when its limit is raised.
 */
export function receivedUsagePercent(sums: CardSums): number {
  const { card, receivedTiyin, receivedMonthTiyin } = sums;
  const share = (used: bigint, limit: bigint): bigint => (used * 100n) / limit;
  let percent = share(receivedTiyin, card.receiveLimitTiyin);
  if (card.monthlyLimitTiyin !== null) {
    const monthly = share(receivedMonthTiyin, card.monthlyLimitTiyin);
    if (monthly > percent) percent = monthly;
  }
  return Number(percent);
}

/** Money RECEIVED (held amounts aside) is above the lifetime or the monthly limit. */
export function isOverReceiveLimit(sums: CardSums): boolean {
  const { card, receivedTiyin, receivedMonthTiyin } = sums;
  if (receivedTiyin > card.receiveLimitTiyin) return true;
  return card.monthlyLimitTiyin !== null && receivedMonthTiyin > card.monthlyLimitTiyin;
}

/**
 * D-42 (1) alert condition: the unpaid held share is above half of what the card may still
 * receive (the smaller of the lifetime and the monthly remainder). A card with nothing left and
 * anything held counts as high.
 */
export function reservedShareHigh(sums: CardSums): boolean {
  const remainder = remainingLimit(sums);
  if (remainder <= 0n) return sums.reservedTiyin > 0n;
  return sums.reservedTiyin * 2n > remainder;
}

/**
 * The `percent` of the `cardReservedHigh` alert: the held share of the remaining limit, rounded
 * down to a whole number (a share, not money). Nothing left counts as 100.
 */
export function reservedSharePercent(sums: CardSums): number {
  const remainder = remainingLimit(sums);
  if (remainder <= 0n) return 100;
  return Number((sums.reservedTiyin * 100n) / remainder);
}

/** What the card may still receive before held amounts: the smaller of lifetime and month. */
function remainingLimit(sums: CardSums): bigint {
  const { card, receivedTiyin, receivedMonthTiyin } = sums;
  const lifetime = card.receiveLimitTiyin - receivedTiyin;
  const monthly =
    card.monthlyLimitTiyin === null ? lifetime : card.monthlyLimitTiyin - receivedMonthTiyin;
  return monthly < lifetime ? monthly : lifetime;
}
