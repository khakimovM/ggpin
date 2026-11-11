// Cross-field rules of the top-up time knobs, checked at boot by BOTH the API (which writes
// `reservedUntil` and allocates against card capacity) and the worker (which matches against
// `reservedUntil` and turns cards FULL with the same capacity hold). One function, so the two
// processes refuse the same configurations.

const DAY_SEC = 86_400;

export interface TopupTuning {
  readonly NODE_ENV: string;
  readonly TOPUP_LATE_GRACE_SEC: number;
  readonly TOPUP_CAPACITY_HOLD_SEC: number;
  readonly TOPUP_INTENT_TTL_SEC: number;
}

/**
 * Production keeps the full 24 h grace of D-37 (2): the 1 h minimum exists for dev and test
 * only (a shorter grace hands an amount to the next user while a slow transfer may still
 * arrive). The capacity hold never outlives the reservation, and in production it is at least
 * the request's lifetime (R-5): a shorter hold would release a card's room while most late
 * transfers for it are still on their way.
 */
export function topupTuningProblems(env: TopupTuning): { name: string; message: string }[] {
  const problems: { name: string; message: string }[] = [];
  if (env.NODE_ENV === 'production' && env.TOPUP_LATE_GRACE_SEC < DAY_SEC) {
    problems.push({
      name: 'TOPUP_LATE_GRACE_SEC',
      message: 'must be at least 86400 in production (the 24 h grace of D-37)',
    });
  }
  // Not a safety bound (the hold already runs from expiresAt): a conservative floor, so a
  // request that just expired keeps its share of the card at least as long as it was open.
  if (env.NODE_ENV === 'production' && env.TOPUP_CAPACITY_HOLD_SEC < env.TOPUP_INTENT_TTL_SEC) {
    problems.push({
      name: 'TOPUP_CAPACITY_HOLD_SEC',
      message: 'must be at least TOPUP_INTENT_TTL_SEC in production',
    });
  }
  if (env.TOPUP_CAPACITY_HOLD_SEC > env.TOPUP_LATE_GRACE_SEC) {
    problems.push({
      name: 'TOPUP_CAPACITY_HOLD_SEC',
      message:
        'must not exceed TOPUP_LATE_GRACE_SEC (capacity is held at most as long as the amount)',
    });
  }
  return problems;
}
