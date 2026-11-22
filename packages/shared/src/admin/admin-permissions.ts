// The admin role matrix: the ONE source of who may do what in the admin panel (phase 9 plan 9.2,
// D-63 (3) and (4)). The API guard reads it per route, the money services re-check the role in
// their transaction, the SPA hides buttons with `permissionsFor` (UX only, never a control), and
// the phase 9 role-matrix test compares `routes` below with the Nest router metadata, so a new
// admin route cannot ship without a row here. A role that may not do something gets `404`.
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
] as const);
export const AdminPermissionSchema = z.enum(ADMIN_PERMISSION_KEYS);
export type AdminPermission = z.infer<typeof AdminPermissionSchema>;

const ALL: readonly AdminRole[] = Object.freeze(['OWNER', 'OPERATOR', 'SUPPORT']);
const STAFF: readonly AdminRole[] = Object.freeze(['OWNER', 'OPERATOR']);
const OWNER: readonly AdminRole[] = Object.freeze(['OWNER']);

const get = (path: string): AdminRouteRef => ({ method: 'GET', path: `/admin/${path}` });
const post = (path: string): AdminRouteRef => ({ method: 'POST', path: `/admin/${path}` });
const patch = (path: string): AdminRouteRef => ({ method: 'PATCH', path: `/admin/${path}` });

function read(roles: readonly AdminRole[], ...routes: AdminRouteRef[]): AdminPermissionRule {
  const rule = { roles, write: false, otp: 'NEVER', operatorLimit: false } as const;
  return { ...rule, ownerOnlyHolds: [], auditActions: [], routes };
}

function write(
  roles: readonly AdminRole[],
  route: AdminRouteRef,
  auditActions: readonly AdminAuditAction[],
  extra: Partial<Pick<AdminPermissionRule, 'otp' | 'operatorLimit' | 'ownerOnlyHolds'>> = {},
): AdminPermissionRule {
  return {
    roles,
    write: true,
    otp: extra.otp ?? 'NEVER',
    operatorLimit: extra.operatorLimit ?? false,
    ownerOnlyHolds: extra.ownerOnlyHolds ?? [],
    auditActions,
    routes: [route],
  };
}

// Within OPERATOR's amount limit, and never a NO_PURCHASE hold (D-64 (6)).
const OPERATOR_MONEY = {
  otp: 'ABOVE_THRESHOLD',
  operatorLimit: true,
  ownerOnlyHolds: ['NO_PURCHASE'],
} as const;
const ALWAYS = { otp: 'ALWAYS' } as const;

/** Freezes a plain tree in place: the matrix cannot be changed at run time (review SA-L2). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const ADMIN_PERMISSIONS: Readonly<Record<AdminPermission, AdminPermissionRule>> = deepFreeze(
  {
    // SUPPORT reads orders, users and payments only (D-63 (3) word for word, D-65 D4).
    'dashboard.read': read(STAFF, get('dashboard')),
    'orders.read': read(ALL, get('orders'), get('orders/review-queue'), get('orders/:id')),
    'users.read': read(
      ALL,
      get('users'),
      get('users/:id'),
      get('users/:id/orders'),
      get('users/:id/ledger'),
      get('users/:id/payments'),
      get('users/:id/referrals'),
      get('users/:id/sessions'),
    ),
    // Field level: SUPPORT sees the phone masked (D-63 (3)).
    'users.phoneFull': read(STAFF),
    'payments.read': read(
      ALL,
      get('payments/intents'),
      get('payments'),
      get('payments/reviews'),
      get('payments/reviews/:id'),
      get('payments/cards'),
      get('payments/bank-messages/:id'),
      get('payments/reconcile'),
    ),
    'payments.creditPreview': read(OWNER, get('payments/reviews/:id/credit-preview')),
    // Field level: the raw bank text, the balance after it and the channel are OWNER-only (D-63 (3),
    // SA-M5); others get `null` in those three fields.
    'payments.bankMessageRaw': read(OWNER),
    'catalog.read': read(
      STAFF,
      get('categories'),
      get('products'),
      get('products/:id'),
      get('products/:id/price-preview'),
    ),
    'settings.read': read(STAFF, get('settings'), get('fx/history')),
    'audit.read': read(STAFF, get('audit-log')),
    // Field level: the audit row's `ip` is shown in full to OWNER only, masked to others (SA-L7).
    'audit.ipFull': read(OWNER),
    'audit.export': { ...read(OWNER, get('audit-log/export.csv')), auditActions: ['AUDIT_EXPORT'] },
    'infra.read': read(
      STAFF,
      get('infra/wallet'),
      get('infra/fragment'),
      get('infra/adapters'),
      get('infra/queues'),
    ),
    'admins.read': read(OWNER, get('admins'), get('admins/:id/sessions')),
    'orders.note': write(ALL, post('orders/:id/notes'), ['ORDER_NOTE']),
    // OPERATOR releases any HELD order except the attempt cap and NO_PURCHASE: those are OWNER's,
    // and only an OWNER release resets the attempt count (p5 S9a).
    'orders.retry': write(STAFF, post('orders/:id/retry'), ['ORDER_RETRY'], {
      ownerOnlyHolds: ['ATTEMPT_CAP', 'NO_PURCHASE'],
    }),
    'orders.cancel': write(STAFF, post('orders/:id/cancel'), ['ORDER_CANCEL'], OPERATOR_MONEY),
    'orders.failAndRefund': write(
      STAFF,
      post('orders/:id/fail-and-refund'),
      ['ORDER_FAIL_REFUND'],
      OPERATOR_MONEY,
    ),
    'orders.resolve': write(OWNER, post('orders/:id/resolve'), ['ORDER_REVIEW_RESOLVE'], {
      otp: 'RULE_OR_ABOVE_THRESHOLD',
    }),
    // A DELIVERED order's refund is money out for goods already given: always the code, and it
    // counts towards the manual-credit daily cap (D-65 D1).
    'orders.refund': write(OWNER, post('orders/:id/refund'), ['ORDER_REFUND'], ALWAYS),
    'users.note': write(ALL, post('users/:id/notes'), ['USER_NOTE']),
    'users.block': write(STAFF, post('users/:id/block'), ['USER_BLOCK']),
    // OPERATOR only blocks; lifting a block is OWNER's, like unfreeze (D-65 D2).
    'users.unblock': write(OWNER, post('users/:id/unblock'), ['USER_UNBLOCK']),
    'users.freeze': write(STAFF, post('users/:id/freeze'), ['USER_FREEZE']),
    'users.unfreeze': write(OWNER, post('users/:id/unfreeze'), ['USER_UNFREEZE']),
    'users.sessionsRevoke': write(STAFF, post('users/:id/sessions/revoke'), [
      'USER_SESSIONS_REVOKE',
    ]),
    'users.adjustWallet': write(OWNER, post('users/:id/adjust-wallet'), ['WALLET_ADJUST'], {
      otp: 'CREDIT_ALWAYS_ELSE_ABOVE_THRESHOLD_OR_DAILY',
    }),
    // Crediting a review puts money into a wallet by hand: always the code (D-66).
    'payments.reviewCredit': write(
      OWNER,
      post('payments/reviews/:id/credit'),
      ['REVIEW_CREDIT'],
      ALWAYS,
    ),
    // Codeless reversals count towards the admin's daily budget with codeless debits (owner
    // decision 2026-11-18, SA-S6-3).
    'payments.reverse': write(OWNER, post('payments/:id/reverse'), ['PAYMENT_REVERSE'], {
      otp: 'ABOVE_THRESHOLD_OR_DAILY',
    }),
    'cards.pause': write(OWNER, post('payments/cards/:id/pause'), ['CARD_PAUSE']),
    // Lifting a SECURITY pause (`confirmSecurityPause`) needs the code (D-65 D3).
    'cards.resume': write(OWNER, post('payments/cards/:id/resume'), ['CARD_RESUME'], {
      otp: 'RULE',
    }),
    // Lowering a limit (receive, or the monthly cap) needs the code; raising it does not; any
    // retire always does (owner decision 2026-11-18, SA-S6-3).
    'cards.limit': write(OWNER, post('payments/cards/:id/limit'), ['CARD_LIMIT'], { otp: 'RULE' }),
    'cards.retire': write(
      OWNER,
      post('payments/cards/:id/retire'),
      ['CARD_RETIRE', 'CARD_RETIRE_EMERGENCY'],
      ALWAYS,
    ),
    'catalog.categoryUpdate': write(OWNER, patch('categories/:id'), ['CATEGORY_UPDATE']),
    'catalog.productUpdate': write(OWNER, patch('products/:id'), ['PRODUCT_UPDATE']),
    'catalog.productReorder': write(OWNER, post('products/reorder'), ['PRODUCT_REORDER']),
    'catalog.skuCreate': write(OWNER, post('products/:id/skus'), ['SKU_CREATE']),
    'catalog.skuUpdate': write(OWNER, patch('skus/:id'), ['SKU_UPDATE']),
    'catalog.routeUpdate': write(OWNER, patch('routes/:id'), ['ROUTE_UPDATE']),
    'fx.set': write(OWNER, post('fx'), ['FX_SET'], { otp: 'RULE' }),
    'admins.create': write(OWNER, post('admins'), ['ADMIN_CREATE'], ALWAYS),
    'admins.update': write(OWNER, patch('admins/:id'), ['ADMIN_UPDATE'], ALWAYS),
    'admins.sessionsRevoke': write(
      OWNER,
      post('admins/:id/sessions/revoke'),
      ['ADMIN_SESSIONS_REVOKE'],
      ALWAYS,
    ),
    'sessions.revoke': write(OWNER, post('sessions/:id/revoke'), ['ADMIN_SESSION_REVOKE'], ALWAYS),
    'queues.retry': write(OWNER, post('infra/queues/:name/jobs/:id/retry'), ['QUEUE_JOB_RETRY']),
    // Issues a step-up code: open to every role that holds at least one action needing one, and
    // then only for an action this admin may perform now (`adminCodeIssueDecision`, SA-M1).
    // The one write with no AuditLog row of its own: issuing a code changes nothing; the action
    // it confirms records `otpVerified` in its audit row (docs/04 «Confirmations», review N8).
    'confirmations.create': write(STAFF, post('confirmations'), []),
  },
);
