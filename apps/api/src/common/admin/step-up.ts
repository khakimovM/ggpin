import { adminOtpRequired } from '@repo/shared';
import { validationError } from './admin-input';
import { isAdminActor, type CheckedAuditActor } from './audit-actor';
import {
  requireOwnerConfirmation,
  type OtpAnswer,
  type OwnerOtpAction,
} from './owner-otp/owner-otp';
import type { OwnerOtpVerifier } from './owner-otp/owner-otp.verifier';

// The one-time code of a money or account action, for either actor (D-46 for the owner CLI,
// D-63 (4) / D-65 for the panel). Same order for both: the code is checked BEFORE the transaction
// (its attempt counted first), the requirement and the re-typed amount INSIDE it, against the
// amount read under the locks.

export interface StepUpCheck {
  /** The CLI's code checker (the owner's code, D-46). */
  readonly owner: Pick<OwnerOtpVerifier, 'verifyIfGiven'>;
  /** The CLI's answer; an admin's is inside its actor (`stepUp`). */
  readonly otp: OtpAnswer | undefined;
  readonly confirmAmountTiyin: bigint | undefined;
  readonly action: OwnerOtpAction;
  readonly target: string;
  /** What the code also confirms, computed by the service (never by the client). */
  readonly flags: string;
  /** A money action: a code needs the re-typed amount it is bound to. */
  readonly money: boolean;
  /** Panel-only binding flags (the codeless budget reason); the CLI's binding never sees them. */
  readonly adminFlags?: readonly string[];
}

/** A service's flags string as the panel's binding lists them (none: an empty list). */
export function stepUpFlagList(flags: string): string[] {
  return flags === '' ? [] : [flags];
}

/** Whether the request carries a code at all (the flags are only worth computing then). */
export function stepUpGiven(actor: CheckedAuditActor, otp: OtpAnswer | undefined): boolean {
  return isAdminActor(actor) ? actor.stepUp !== undefined : otp !== undefined;
}

/** False when no code was given; true once the given code is verified (it is then used up). */
export async function verifyStepUp(actor: CheckedAuditActor, check: StepUpCheck): Promise<boolean> {
  if (!isAdminActor(actor)) {
    return check.owner.verifyIfGiven(
      check.otp,
      check.confirmAmountTiyin,
      check.action,
      check.target,
      check.flags,
    );
  }
  if (actor.stepUp === undefined) return false;
  if (check.money && check.confirmAmountTiyin === undefined) {
    throw validationError('confirmAmountTiyin', 'AMOUNT_MISMATCH');
  }
  await actor.stepUp.verify([...stepUpFlagList(check.flags), ...(check.adminFlags ?? [])]);
  return true;
}

/** An action without an amount (card resume): only the panel has a code to check. */
export async function verifyAdminStepUp(actor: CheckedAuditActor): Promise<boolean> {
  if (!isAdminActor(actor) || actor.stepUp === undefined) return false;
  await actor.stepUp.verify([]);
  return true;
}

export interface StepUpRequirement {
  /** The real amount read under the locks (signed for an adjustment); absent when none. */
  readonly amountTiyin?: bigint;
  readonly confirmAmountTiyin: bigint | undefined;
  readonly verified: boolean;
  readonly thresholdTiyin: bigint;
  /** The domain rule's verdict (card resume: a SECURITY pause is lifted). */
  readonly ruleRequiresCode?: boolean;
  /** Panel: the admin's codeless daily budget is passed (read under its lock); absent = unknown. */
  readonly codelessBudgetExceeded?: boolean;
}

/**
 * Inside the transaction: refuses when a code is needed and missing, or the re-typed amount is
 * not the real one. CLI: above the threshold (D-46). Panel: the matrix rule of the route's
 * permission (`adminOtpRequired`, e.g. a credit always, D-65 D1 / D-66).
 */
export function requireStepUp(actor: CheckedAuditActor, need: StepUpRequirement): void {
  if (!isAdminActor(actor)) {
    if (need.amountTiyin === undefined) return;
    requireOwnerConfirmation(
      need.amountTiyin,
      need.confirmAmountTiyin,
      need.verified,
      need.thresholdTiyin,
    );
    return;
  }
  const required = adminOtpRequired(actor.permission, {
    ...(need.amountTiyin === undefined ? {} : { amountTiyin: need.amountTiyin }),
    thresholdTiyin: need.thresholdTiyin,
    ...(need.ruleRequiresCode === undefined ? {} : { ruleRequiresCode: need.ruleRequiresCode }),
    ...(need.codelessBudgetExceeded === undefined
      ? {}
      : { codelessBudgetExceeded: need.codelessBudgetExceeded }),
  });
  if (!required) return;
  // No code yet is OTP_REQUIRED (what the panel must ask for first); a checked code with another
  // re-typed amount is AMOUNT_MISMATCH (the amount may have changed under the locks).
  if (!need.verified) throw validationError('otp', 'OTP_REQUIRED');
  if (need.amountTiyin !== undefined && need.confirmAmountTiyin !== need.amountTiyin) {
    throw validationError('confirmAmountTiyin', 'AMOUNT_MISMATCH');
  }
}
