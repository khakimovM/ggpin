import { randomInt } from 'node:crypto';

// Picks the unique pay amount of a new top-up request on ONE card (docs/05 §3). Pure: the
// caller holds that card's advisory lock and passes in what the database says about the
// amounts near the base. The amount itself is the payment's identifier, so the rules are:
//   1. never an amount still reserved on this card (`reservedUntil > now`, any status: a
//      paid, expired or cancelled amount may still receive a late or repeated transfer);
//   2. prefer a "fresh" amount nobody has held in the recent window (default 7 days), chosen
//      at random so the next amount cannot be guessed;
//   3. otherwise the least recently held free amount (LRU): the one a very late transfer is
//      least likely to still be heading for;
//   4. nothing free: null, the caller tries the next card.

export const SOM_TIYIN = 100n;
/** "Recently held" window of rule 2 (docs/05 §3, a recommendation there). */
export const RECENT_AMOUNT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface AmountUsage {
  /** The pay amount (base + suffix) in tiyin. */
  readonly amountTiyin: bigint;
  /** The latest `reservedUntil` of any intent on this card with that amount. */
  readonly lastReservedUntil: Date;
}

export interface AllocationInput {
  readonly baseTiyin: bigint;
  /** Suffixes are 1..suffixMaxSom whole so'm. */
  readonly suffixMaxSom: number;
  /** Amounts held on this card since `now - RECENT_AMOUNT_WINDOW_MS` (older rows may be omitted). */
  readonly usage: readonly AmountUsage[];
  readonly now: Date;
  /** Uniform integer in [0, n); crypto.randomInt in production, seeded in tests. */
  readonly random?: (n: number) => number;
}

/** DI token of the suffix random source: crypto in production, fixed in some tests. */
export const AMOUNT_RANDOM = Symbol('AMOUNT_RANDOM');
export type AmountRandom = (n: number) => number;
export const cryptoAmountRandom: AmountRandom = (n) => randomInt(n);

export function allocateAmount(input: AllocationInput): bigint | null {
  const random = input.random ?? cryptoAmountRandom;
  const nowMs = input.now.getTime();
  const recentFrom = nowMs - RECENT_AMOUNT_WINDOW_MS;
  const lastHeld = new Map<bigint, number>();
  for (const row of input.usage) {
    const at = row.lastReservedUntil.getTime();
    const known = lastHeld.get(row.amountTiyin);
    if (known === undefined || at > known) lastHeld.set(row.amountTiyin, at);
  }

  const fresh: bigint[] = [];
  let lru: { amount: bigint; at: number } | null = null;
  for (let suffix = 1; suffix <= input.suffixMaxSom; suffix += 1) {
    const amount = input.baseTiyin + BigInt(suffix) * SOM_TIYIN;
    const at = lastHeld.get(amount);
    if (at === undefined || at <= recentFrom) {
      fresh.push(amount);
    } else if (at <= nowMs && (lru === null || at < lru.at)) {
      // Strictly older wins; on a tie the smaller suffix stays (deterministic, still unguessable
      // in practice because ties need two reservations ending in the same millisecond).
      lru = { amount, at };
    }
  }
  if (fresh.length > 0) {
    const index = random(fresh.length);
    return fresh[index] ?? null;
  }
  return lru?.amount ?? null;
}
