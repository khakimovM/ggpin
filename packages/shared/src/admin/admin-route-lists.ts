// The admin route and action lists that sit beside the role matrix (admin-permissions.ts). Both
// are frozen (review N8): an untyped caller cannot add a session-less route or an OTP action.
import type { AdminAuditAction } from './admin-audit-actions';
import type { AdminPermission, AdminRouteRef } from './admin-permissions';

export interface AdminAuthRoute extends AdminRouteRef {
  readonly session: boolean;
  readonly auditAction: AdminAuditAction | null;
}

const route = (
  method: AdminRouteRef['method'],
  path: string,
  session: boolean,
  auditAction: AdminAuditAction | null,
): AdminAuthRoute => Object.freeze({ method, path: `/admin/${path}`, session, auditAction });

/**
 * Admin routes outside the matrix: the login flow (no session yet) and the two any-admin routes.
 * Together with `ADMIN_PERMISSIONS[*].routes` they are every `/admin/*` route.
 */
export const ADMIN_AUTH_ROUTES: readonly AdminAuthRoute[] = Object.freeze([
  route('POST', 'auth/start', false, null),
  route('GET', 'auth/status/:nonce', false, null),
  route('POST', 'auth/verify', false, 'ADMIN_LOGIN'),
  route('POST', 'auth/logout', true, 'ADMIN_LOGOUT'),
  route('GET', 'auth/me', true, null),
]);

/** The actions whose body may carry `otp` (the `action` of `POST /admin/confirmations`). */
export const ADMIN_OTP_PERMISSIONS = Object.freeze([
  'orders.cancel',
  'orders.failAndRefund',
  'orders.resolve',
  'orders.refund',
  'users.adjustWallet',
  'payments.reviewCredit',
  'payments.reverse',
  'cards.resume',
  'fx.set',
  'admins.create',
  'admins.update',
  'admins.sessionsRevoke',
  'sessions.revoke',
] as const satisfies readonly AdminPermission[]);
export type AdminOtpPermission = (typeof ADMIN_OTP_PERMISSIONS)[number];
