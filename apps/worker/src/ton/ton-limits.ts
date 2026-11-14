// Hot-wallet limits (rules/45, docs/06 "Limitlar"; plan 6.6 step 7). Pure bigint comparisons in
// nanotons; the rolling 24 h sum comes from the database inside the signing transaction
// (TonTransferRepository), so two payouts cannot both pass the daily limit: the wallet's single
// unresolved transfer (a partial unique index) lets only one of them be signed at a time.
// "Exactly at the limit" is allowed; one nanoton more is refused (the order is HELD).

export interface TonLimits {
  readonly perOrderMaxNano: bigint;
  readonly dailyMaxNano: bigint;
}

export type TonLimitRefusal = 'LIMIT_PER_ORDER' | 'LIMIT_DAILY';

export type TonLimitVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: TonLimitRefusal };

/**
 * `spentLast24hNano` counts EVERY transfer of the wallet of the last 24 hours (spentLast24h,
 * ton-sign-guards.ts), whatever its status: the EXPIRED ones (provably never sent) too, and the
 * bounced and failed ones. Conservative (audit I-4): a payout re-signed after EXPIRED counts twice
 * towards the daily limit, so the limit can only refuse earlier, never let more out (D-60 (2)).
 */
export function checkTonLimits(
  amountNano: bigint,
  spentLast24hNano: bigint,
  limits: TonLimits,
): TonLimitVerdict {
  if (amountNano <= 0n) throw new RangeError('a TON payout must be a positive amount');
  if (spentLast24hNano < 0n) throw new RangeError('the spent sum cannot be negative');
  if (amountNano > limits.perOrderMaxNano) return { ok: false, reason: 'LIMIT_PER_ORDER' };
  if (spentLast24hNano + amountNano > limits.dailyMaxNano) {
    return { ok: false, reason: 'LIMIT_DAILY' };
  }
  return { ok: true };
}

/** The balance pays the amount and keeps the fee reserve (D-56 (12): fees are not in maxCost). */
export function coversPayout(
  balanceNano: bigint,
  amountNano: bigint,
  feeReserveNano: bigint,
): boolean {
  return balanceNano >= amountNano + feeReserveNano;
}

/** Under the alert threshold (TON_MIN_BALANCE_ALERT_NANO): the owner is told. */
export function isLowBalance(balanceNano: bigint, alertBelowNano: bigint): boolean {
  return balanceNano < alertBelowNano;
}
