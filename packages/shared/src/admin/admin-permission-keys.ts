// The vocabulary of the admin role matrix (admin-permissions.ts): the permission keys and the
// shape of a rule. Kept apart from the matrix itself only for the 300-line file limit.
import { z } from 'zod';
import type { AdminAuditAction } from './admin-audit-actions';
import type { AdminRole } from './admin-roles';

/**
 * When the acting admin must type a one-time code from the bot (D-63 (4)):
 * - `ABOVE_THRESHOLD` — the money moved is above `ADMIN_CONFIRM_THRESHOLD_TIYIN` (by magnitude);
 * - `RULE_OR_ABOVE_THRESHOLD` — that, or the domain rule says so (NEEDS_REVIEW resolve: the
 *   proof kinds of phase 5 `proofNeedsOwnerOtp`, MANUAL among them, D-59 (7));
 * - `RULE` — only the domain rule (manual FX: the jump flags of phase 5 FxAdminService, D-56 (3);
 *   card resume: lifting a SECURITY pause, D-65 D3);
 * - `CREDIT_ALWAYS_ELSE_ABOVE_THRESHOLD_OR_DAILY` — a wallet adjustment: always for a credit
 *   (money created by hand, D-65 D1); a debit above the threshold, or once the admin's codeless
 *   debits and reversals of the Tashkent day pass the daily budget (admin-codeless-budget.ts);
 * - `ABOVE_THRESHOLD_OR_DAILY` — a top-up reversal: above the threshold or past that budget;
 * - `ALWAYS` — every admin-management action and the refund of a DELIVERED order (D-65 D1).
 */
export type AdminOtpRule =
  | 'NEVER'
  | 'ABOVE_THRESHOLD'
  | 'RULE_OR_ABOVE_THRESHOLD'
  | 'RULE'
  | 'CREDIT_ALWAYS_ELSE_ABOVE_THRESHOLD_OR_DAILY'
  | 'ABOVE_THRESHOLD_OR_DAILY'
  | 'ALWAYS';

/**
 * A held order OPERATOR may not touch even within its limits: the attempt cap (p5 S9a
 * `attemptLimitReached`, counted by `attemptNo`; only an OWNER release resets it) and the
 * NO_PURCHASE hold (D-64 (6)). The server computes both under the order lock.
 */
export type AdminOrderHold = 'ATTEMPT_CAP' | 'NO_PURCHASE';

export type AdminRouteMethod = 'GET' | 'POST' | 'PATCH';

/** A route of the admin API, path below `/api/v1`, in Nest's `:param` form. */
export interface AdminRouteRef {
  readonly method: AdminRouteMethod;
  readonly path: string;
}

export interface AdminPermissionRule {
  readonly roles: readonly AdminRole[];
  /** Changes state (audited). A read that is audited (CSV export) stays `false`. */
  readonly write: boolean;
  readonly otp: AdminOtpRule;
  /** OPERATOR passes only when the order total is within `ADMIN_OPERATOR_REFUND_MAX_TIYIN`. */
  readonly operatorLimit: boolean;
  /** Holds under which OPERATOR gets `404` here: such an order is OWNER's (D-64 (6), p5 S9a). */
  readonly ownerOnlyHolds: readonly AdminOrderHold[];
  /** `AuditLog.action` a successful call writes (one of them). */
  readonly auditActions: readonly AdminAuditAction[];
  /** Empty for a field-level permission (what a response may show). */
  readonly routes: readonly AdminRouteRef[];
}

export const ADMIN_PERMISSION_KEYS = Object.freeze([
  'dashboard.read',
  'orders.read',
  'users.read',
  'users.phoneFull',
  'users.adjustPreview',
  'payments.read',
  'payments.creditPreview',
  'payments.bankMessageRaw',
  'catalog.read',
  'settings.read',
  'audit.read',
  'audit.ipFull',
  'audit.export',
  'infra.read',
  'admins.read',
  'orders.note',
  'orders.retry',
  'orders.cancel',
  'orders.failAndRefund',
  'orders.resolve',
  'orders.refund',
  'users.note',
  'users.block',
  'users.unblock',
  'users.freeze',
  'users.unfreeze',
  'users.sessionsRevoke',
  'users.adjustWallet',
  'payments.reviewCredit',
  'payments.reverse',
  'cards.pause',
  'cards.resume',
  'cards.limit',
  'cards.retire',
  'catalog.categoryUpdate',
  'catalog.productUpdate',
  'catalog.productReorder',
  'catalog.skuCreate',
  'catalog.skuUpdate',
  'catalog.routeUpdate',
  'fx.set',
  'admins.create',
  'admins.update',
  'admins.sessionsRevoke',
  'sessions.revoke',
  'queues.retry',
  'confirmations.create',
  'writeKeys.void',
] as const);
export const AdminPermissionSchema = z.enum(ADMIN_PERMISSION_KEYS);
export type AdminPermission = z.infer<typeof AdminPermissionSchema>;
