// Referral bonus, cashback, reward reversal and discount amounts (phase 10, D-72 (3)-(7)).
// Composed only from the money module's primitives (mulDiv, percentOf), so the rounding stays in
// one place; this file only says WHICH way each amount rounds (.claude/rules/40-domain-money.md):
// - given to a user (referral bonus, cashback coins, a discount): DOWN;
// - taken back from a user (the reversal of a reward on an admin refund): UP, but never more
//   than what is still left of what was given.
// Every amount is a bigint: tiyin for money, whole coins for cashback. No FX is involved.
import { MoneyError, mulDiv, percentOf } from '../money';

const BPS_DENOMINATOR = 10_000n;
const TIYIN_PER_SOM = 100n;

function requireAmount(value: bigint, name: string, min: bigint): void {
  // Runtime guard: a JS caller passing a number must never reach the math.
  if (typeof value !== 'bigint') throw new MoneyError(`${name} must be a bigint`);
  if (value < min) throw new MoneyError(`${name} must be at least ${min.toString()}`);
}

function bpsOf(bps: number, max: number): bigint {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > max) {
    throw new MoneyError(`bps must be an integer from 0 to ${String(max)}`);
  }
  return BigInt(bps);
}

function smaller(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** A tiyin amount rounded DOWN to a whole so'm (a credit to a user has no tiyin). */
function floorToSom(tiyin: bigint): bigint {
  return mulDiv(tiyin, 1n, TIYIN_PER_SOM, 'down') * TIYIN_PER_SOM;
}

/**
 * The inviter's bonus for a delivered order (D-72 (3)): `bps` of what the buyer paid (price minus
 * discount), rounded DOWN to a whole so'm with one rounding at the end. 0 when it rounds to nothing.
 */
export function referralBonusTiyin(paidTiyin: bigint, bps: number): bigint {
  requireAmount(paidTiyin, 'paid amount', 0n);
  return (
    mulDiv(paidTiyin, bpsOf(bps, 10_000), BPS_DENOMINATOR * TIYIN_PER_SOM, 'down') * TIYIN_PER_SOM
  );
}

/**
 * The buyer's cashback coins for a delivered order (D-72 (4)): `bps` of what was paid, counted in
 * coins of `coinUnitTiyin` (1 coin = 100 so'm of cashback), rounded DOWN to a whole coin.
 */
export function cashbackCoins(paidTiyin: bigint, bps: number, coinUnitTiyin: bigint): bigint {
  requireAmount(paidTiyin, 'paid amount', 0n);
  requireAmount(coinUnitTiyin, 'coin unit', 1n);
  return mulDiv(paidTiyin, bpsOf(bps, 10_000), BPS_DENOMINATOR * coinUnitTiyin, 'down');
}

export interface ReversalShareInput {
  /** What the delivery granted (OrderReward): tiyin of a bonus or whole coins. */
  readonly granted: bigint;
  /** What earlier refunds of the same order already took back. */
  readonly alreadyReversed: bigint;
  /** What earlier refunds of the same order gave back to the buyer, in tiyin. */
  readonly refundedBeforeTiyin: bigint;
  /** This refund, in tiyin. */
  readonly refundTiyin: bigint;
  /** What the buyer paid for the order (price minus discount), in tiyin. */
  readonly paidTiyin: bigint;
  /** A full refund takes back exactly what is left. */
  readonly full: boolean;
}

/**
 * How much of a granted reward one admin refund takes back (D-72 (7)). Partial: CUMULATIVE, so
 * many small refunds take no more than one refund of their sum: after this refund the reversals
 * add up to `ceil(granted × refundedSoFar / paid)` (taken from a user, so UP, rounded once), never
 * less than what was already taken and never more than the grant. Full: exactly what is left, so
 * a full refund after partial ones closes the reward to the unit.
 */
export function reversalShare(input: ReversalShareInput): bigint {
  const { granted, alreadyReversed, refundedBeforeTiyin, refundTiyin, paidTiyin, full } = input;
  requireAmount(granted, 'granted', 0n);
  requireAmount(alreadyReversed, 'already reversed', 0n);
  if (alreadyReversed > granted) throw new MoneyError('already reversed is more than granted');
  const left = granted - alreadyReversed;
  if (full) return left;
  requireAmount(paidTiyin, 'paid amount', 1n);
  requireAmount(refundedBeforeTiyin, 'refunded before', 0n);
  requireAmount(refundTiyin, 'refund', 1n);
  const refundedSoFar = refundedBeforeTiyin + refundTiyin;
  if (refundedSoFar > paidTiyin) throw new MoneyError('refunds are more than the payment');
  const due = mulDiv(granted, refundedSoFar, paidTiyin, 'up') - alreadyReversed;
  return due > 0n ? smaller(due, left) : 0n;
}

export interface CapReferralBonusInput {
  /** The bonus this delivery would grant (referralBonusTiyin). */
  readonly bonusTiyin: bigint;
  /** GROSS referral bonus the inviter got today (Tashkent day): reversals do not free the cap. */
  readonly grantedTodayTiyin: bigint;
  /** REFERRAL_DAILY_CAP_TIYIN. */
  readonly capTiyin: bigint;
}

/**
 * The bonus actually granted under the inviter's daily cap (D-72 (3)): what fits under the cap is
 * given (99 500 so'm given today, a new 1 000 so'm bonus -> 500 so'm), the rest is never given and
 * never carried to another day. 0 means `skipReason: DAILY_CAP` (when the bonus itself was not 0).
 * Rounded DOWN to a whole so'm, like every credit to a user.
 */
export function capReferralBonus(input: CapReferralBonusInput): bigint {
  const { bonusTiyin, grantedTodayTiyin, capTiyin } = input;
  requireAmount(bonusTiyin, 'bonus', 0n);
  requireAmount(grantedTodayTiyin, 'granted today', 0n);
  requireAmount(capTiyin, 'daily cap', 0n);
  const room = capTiyin - grantedTodayTiyin;
  return room > 0n ? floorToSom(smaller(bonusTiyin, room)) : 0n;
}

export interface DiscountForQuoteInput {
  /** The quote's price, in tiyin. */
  readonly priceTiyin: bigint;
  /** The code's discount (DiscountTier.bps snapshot), 0..9999. */
  readonly bps: number;
  /** The code's cap in tiyin (D-72 (5)); every tier has one. */
  readonly maxDiscountTiyin: bigint;
}

/**
 * The discount of a quote paid with a discount code (D-72 (5)): `bps` of the price rounded DOWN,
 * then held to the code's cap, then DOWN to a whole so'm. Always below the price (bps < 100%),
 * so `totalAfterDiscount` never reaches zero.
 */
export function discountForQuote(input: DiscountForQuoteInput): bigint {
  const { priceTiyin, bps, maxDiscountTiyin } = input;
  requireAmount(priceTiyin, 'price', 0n);
  requireAmount(maxDiscountTiyin, 'discount cap', 0n);
  bpsOf(bps, 9_999); // a discount of 100% or more is no discount code
  return floorToSom(smaller(percentOf(priceTiyin, bps, 'down'), maxDiscountTiyin));
}
