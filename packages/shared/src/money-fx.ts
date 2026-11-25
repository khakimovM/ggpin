// FX rate comparisons (the owner's manual rate, D-35 (a), (b), (e); plan Q4). Part of the money
// module (.claude/rules/40-domain-money.md): rates are decimal strings and are compared only as
// BigInts, never as floats.
import { FX_PAIRS, convertPair, mulDiv, percentOf, type FxPair } from './money';

// Both rates convert the same reference amount of the pair's base currency into the quote
// currency. 10^30 minor units keep the result exact for every stored pair and every rate with up
// to 18 decimals (the most a rate may have), so equal rates compare equal and the order is exact.
const REFERENCE_AMOUNT = 10n ** 30n;

function scaled(pair: FxPair, rate: string): bigint {
  return convertPair({
    amount: REFERENCE_AMOUNT,
    pair,
    from: FX_PAIRS[pair].base,
    rate,
    rounding: 'down',
  });
}

/** -1, 0 or 1 as `a` is below, equal to or above `b` (both rates of `pair`). */
export function compareFxRates(pair: FxPair, a: string, b: string): -1 | 0 | 1 {
  const x = scaled(pair, a);
  const y = scaled(pair, b);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** True when `rate` lies in `[bounds.min, bounds.max]` (both inclusive). */
export function fxRateWithin(
  pair: FxPair,
  rate: string,
  bounds: { readonly min: string; readonly max: string },
): boolean {
  return compareFxRates(pair, rate, bounds.min) >= 0 && compareFxRates(pair, rate, bounds.max) <= 0;
}

/**
 * True when `next` is more than `maxJumpBps` away from `previous`, in either direction, measured
 * against `previous`. A move of exactly the limit is not a jump. The limit is rounded down, so a
 * move a fraction of a unit above it already counts (the safe side: the owner confirms).
 */
export function fxRateMovesMoreThan(
  pair: FxPair,
  previous: string,
  next: string,
  maxJumpBps: number,
): boolean {
  const before = scaled(pair, previous);
  const after = scaled(pair, next);
  const move = after > before ? after - before : before - after;
  return move > percentOf(before, maxJumpBps, 'down');
}

/** The move from `previous` to `next` in whole basis points, rounded up (for the owner to read). */
export function fxRateMoveBps(pair: FxPair, previous: string, next: string): bigint {
  const before = scaled(pair, previous);
  const after = scaled(pair, next);
  const move = after > before ? after - before : before - after;
  return mulDiv(move, 10_000n, before, 'up');
}
