import { FX_MAX_JUMP_BPS, FX_PAIRS, convertPair, percentOf, type FxPair } from '@repo/shared';

// Rates are compared through the shared money functions, never as floats: both rates convert
// the same large reference amount (10^18 minor units of the pair's base currency) and the two
// BigInt results are compared. For every stored pair this is exact for rates with up to 14
// decimals; beyond that the floor cut moves the result by under 10^-14 of the rate.
const REFERENCE_AMOUNT = 10n ** 18n;

function scaled(pair: FxPair, rate: string): bigint {
  return convertPair({
    amount: REFERENCE_AMOUNT,
    pair,
    from: FX_PAIRS[pair].base,
    rate,
    rounding: 'down',
  });
}

/**
 * True when `next` is more than `maxJumpBps` away from `previous`, in either direction.
 * A move of exactly the limit is allowed. A source glitch (a missing digit, a stale cache, a
 * hijacked feed) shows up as such a jump; the rate is then not stored, and quotes stop once the
 * last good rate is 30 minutes old instead of selling at a wrong price.
 */
export function exceedsJumpLimit(
  pair: FxPair,
  previous: string,
  next: string,
  maxJumpBps: number = FX_MAX_JUMP_BPS,
): boolean {
  const before = scaled(pair, previous);
  const after = scaled(pair, next);
  const move = after > before ? after - before : before - after;
  return move > percentOf(before, maxJumpBps, 'down');
}
