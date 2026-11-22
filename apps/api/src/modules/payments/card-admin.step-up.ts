import type { TopupCard } from '@repo/db';
import { isAdminActor, type CheckedAuditActor } from '../../common/admin/audit-actor';
import { requireStepUp } from '../../common/admin/step-up';
import type { AuditExtra } from './card-admin.types';

// The panel's code for a card retire (always) and a limit that lowers one (owner decision
// 2026-11-18, SA-S6-3). The code itself is checked before the transaction (verifyAdminStepUp);
// whether it was needed is decided here, under the card lock. The CLI is not asked.

/** The new limits, as setLimit takes them (`null` monthly = no monthly cap, `undefined` = keep). */
export interface CardLimits {
  readonly limitTiyin: bigint;
  readonly monthlyLimitTiyin?: bigint | null;
}

/**
 * True when the change lowers a limit: a smaller receive limit, or a monthly cap set where there
 * was none or made smaller. Removing the monthly cap or keeping it is never lowering.
 */
export function lowersCardLimit(
  card: Pick<TopupCard, 'receiveLimitTiyin' | 'monthlyLimitTiyin'>,
  limits: CardLimits,
): boolean {
  if (limits.limitTiyin < card.receiveLimitTiyin) return true;
  const monthly = limits.monthlyLimitTiyin;
  if (monthly === undefined || monthly === null) return false;
  return card.monthlyLimitTiyin === null || monthly < card.monthlyLimitTiyin;
}

/**
 * Inside the transaction: refuses `OTP_REQUIRED` when the rule asks and no code was verified;
 * returns the audit field that records whether the panel's code was given (admin only).
 */
export function requireCardStepUp(
  actor: CheckedAuditActor,
  verified: boolean,
  ruleRequiresCode: boolean,
): AuditExtra {
  requireStepUp(actor, {
    confirmAmountTiyin: undefined,
    verified,
    thresholdTiyin: 0n,
    ruleRequiresCode,
  });
  return isAdminActor(actor) ? { otpVerified: verified } : {};
}
