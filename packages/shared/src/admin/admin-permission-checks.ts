// Checks over the admin role matrix (admin-permissions.ts): the API guard and the money services
// call these, the SPA calls `permissionsFor`. Kept apart only for the 300-line file limit.
import type { AdminRole } from './admin-roles';
import {
  ADMIN_PERMISSION_KEYS,
  ADMIN_PERMISSIONS,
  type AdminOrderHold,
  type AdminOtpRule,
  type AdminPermission,
} from './admin-permissions';
import type { AdminOtpPermission } from './admin-route-lists';

/**
 * True when `role` holds `permission` (before any amount limit). A key that is not in the matrix
 * (a typo reaching run time through an untyped caller) is `false`, never a crash or a prototype
 * property.
 */
export function roleHas(role: AdminRole, permission: AdminPermission): boolean {
  return (
    Object.hasOwn(ADMIN_PERMISSIONS, permission) &&
    ADMIN_PERMISSIONS[permission].roles.includes(role)
  );
}

/** What the SPA shows for a role (`GET /admin/auth/me` `permissions`), in matrix order. */
export function permissionsFor(role: AdminRole): AdminPermission[] {
  return ADMIN_PERMISSION_KEYS.filter((key) => roleHas(role, key));
}

/** OPERATOR may cancel / fail-and-refund an order whose WHOLE total is at most the limit. */
export function canOperatorRefund(totalTiyin: bigint, limitTiyin: bigint): boolean {
  return totalTiyin <= limitTiyin;
}

/** What the server reads under the order lock before an order action (never from the client). */
export interface AdminOrderContext {
  readonly totalTiyin: bigint;
  readonly operatorLimitTiyin: bigint;
  /** HELD at the attempt cap (p5 `attemptLimitReached`, counted by `attemptNo`). */
  readonly attemptCapHold: boolean;
  /** HELD with the NO_PURCHASE reason (D-64 (6)). */
  readonly noPurchaseHold: boolean;
}

/**
 * The full role check of one action. Fail-closed: an action with an OPERATOR limit or an
 * owner-only hold is refused for OPERATOR without the order's context. The API answers `404`
 * for `false` (D-26, D-63 (3)).
 */
export function adminMayPerform(
  role: AdminRole,
  permission: AdminPermission,
  order?: AdminOrderContext,
): boolean {
  if (!roleHas(role, permission)) return false;
  if (role !== 'OPERATOR') return true;
  const rule = ADMIN_PERMISSIONS[permission];
  if (!rule.operatorLimit && rule.ownerOnlyHolds.length === 0) return true;
  if (order === undefined) return false;
  if (rule.operatorLimit && !canOperatorRefund(order.totalTiyin, order.operatorLimitTiyin)) {
    return false;
  }
  const held = (hold: AdminOrderHold): boolean => rule.ownerOnlyHolds.includes(hold);
  if (held('ATTEMPT_CAP') && order.attemptCapHold) return false;
  return !(held('NO_PURCHASE') && order.noPurchaseHold);
}

export interface OtpCheckInput {
  /** Money moved by the action (signed for a wallet adjustment); absent when none. */
  readonly amountTiyin?: bigint;
  readonly thresholdTiyin: bigint;
  /** The domain rule's own verdict (proof kind, FX jump flags); absent = unknown. */
  readonly ruleRequiresCode?: boolean;
}

const magnitude = (tiyin: bigint): bigint => (tiyin < 0n ? -tiyin : tiyin);

/**
 * Whether the action needs the acting admin's one-time code. Fail-closed: an unknown amount or
 * an unknown domain verdict counts as "needed". At the threshold itself no code is needed (the
 * CLI rule, `requireOwnerConfirmation`).
 */
export function adminOtpRequired(permission: AdminPermission, input: OtpCheckInput): boolean {
  const above = (): boolean =>
    input.amountTiyin === undefined || magnitude(input.amountTiyin) > input.thresholdTiyin;
  const rule = (): boolean => input.ruleRequiresCode ?? true;
  // A key outside the matrix (an untyped caller) has no rule and falls to `default`.
  const otpRule: AdminOtpRule | undefined = Object.hasOwn(ADMIN_PERMISSIONS, permission)
    ? ADMIN_PERMISSIONS[permission].otp
    : undefined;
  switch (otpRule) {
    case 'NEVER':
      return false;
    case 'ALWAYS':
      return true;
    case 'ABOVE_THRESHOLD':
      return above();
    case 'RULE_OR_ABOVE_THRESHOLD':
      return rule() || above();
    case 'RULE':
      return rule();
    case 'CREDIT_ALWAYS_ELSE_ABOVE_THRESHOLD':
      return input.amountTiyin === undefined || input.amountTiyin > 0n || above();
    default:
      // An unknown rule at run time asks for the code (fail closed, review SA-L2).
      return true;
  }
}

export type CodeIssueDecision = 'ISSUE' | 'NOT_FOUND' | 'NOT_REQUIRED';

/**
 * `POST /admin/confirmations` (review SA-M1, CR-M4): a code is issued only for an action this
 * admin may perform now (role, and OPERATOR's order limit) — otherwise `404` like the action
 * itself — and only when the action needs one (`NOT_REQUIRED` → `400`, nothing is sent). The
 * server fills `input` from its own reads, never from the client's amounts.
 */
export function adminCodeIssueDecision(
  role: AdminRole,
  action: AdminOtpPermission,
  input: { readonly order?: AdminOrderContext; readonly otp: OtpCheckInput },
): CodeIssueDecision {
  if (!roleHas(role, 'confirmations.create') || !adminMayPerform(role, action, input.order)) {
    return 'NOT_FOUND';
  }
  return adminOtpRequired(action, input.otp) ? 'ISSUE' : 'NOT_REQUIRED';
}
