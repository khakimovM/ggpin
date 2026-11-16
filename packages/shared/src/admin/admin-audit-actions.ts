// `AuditLog.action` values written by the admin panel (phase 9). Where the owner CLI already
// writes the same action, the name is the CLI's, byte for byte, so one filter finds both and the
// DB guards keyed on an action name (e.g. `ORDER_REVIEW_RESOLVE`, docs/06) keep working:
//   main:  WALLET_ADJUST, PAYMENT_REVERSE (modules/wallet/wallet-admin.replay.ts), USER_UNFREEZE
//          (wallet-unfreeze.service.ts), REVIEW_CREDIT (payments/review-credit.service.ts),
//          CARD_PAUSE, CARD_RESUME (card-pause.repository.ts), CARD_LIMIT, CARD_RETIRE,
//          CARD_RETIRE_EMERGENCY (card-admin.service.ts);
//   phase 5 (feat/p5-stars-order): ORDER_RETRY, ORDER_REVIEW_RESOLVE
//          (modules/orders/admin/order-admin.repository.ts), FX_SET (fx-admin.repository.ts).
import { z } from 'zod';

export const ADMIN_AUDIT_ACTIONS = [
  // session (D-63 (9): every login is audited and announced)
  'ADMIN_LOGIN',
  'ADMIN_LOGOUT',
  // orders
  'ORDER_NOTE',
  'ORDER_RETRY',
  'ORDER_REVIEW_RESOLVE',
  'ORDER_CANCEL',
  'ORDER_FAIL_REFUND',
  'ORDER_REFUND',
  // users
  'USER_NOTE',
  'USER_BLOCK',
  'USER_UNBLOCK',
  'USER_FREEZE',
  'USER_UNFREEZE',
  'USER_SESSIONS_REVOKE',
  'WALLET_ADJUST',
  // payments and receiving cards
  'REVIEW_CREDIT',
  'PAYMENT_REVERSE',
  'CARD_PAUSE',
  'CARD_RESUME',
  'CARD_LIMIT',
  'CARD_RETIRE',
  'CARD_RETIRE_EMERGENCY',
  // catalog
  'CATEGORY_UPDATE',
  'PRODUCT_UPDATE',
  'PRODUCT_REORDER',
  'SKU_CREATE',
  'SKU_UPDATE',
  'ROUTE_UPDATE',
  // settings
  'FX_SET',
  // admins
  'ADMIN_CREATE',
  'ADMIN_UPDATE',
  'ADMIN_SESSIONS_REVOKE',
  'ADMIN_SESSION_REVOKE',
  // infra and audit
  'QUEUE_JOB_RETRY',
  'AUDIT_EXPORT',
] as const;

export const AdminAuditActionSchema = z.enum(ADMIN_AUDIT_ACTIONS);
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;

/**
 * Actions that exist in the audit log but are never written by the panel: owner-CLI-only ones
 * (`CARD_ADD` needs the full card number, D-63 (6); the review closings) and the system's own.
 * The audit-log screen still shows and filters them.
 */
export const NON_PANEL_AUDIT_ACTIONS = [
  'CARD_ADD',
  'REVIEW_IGNORE',
  'REVIEW_RETURNED_OFFLINE',
  'REVIEW_ACCEPT_CHAIN',
  'CARD_RETIRE_DRAINED',
  'PAYMENT_RECONCILE',
] as const;

/**
 * The `action` filter of `GET /admin/audit-log`: any upper-case action name, not only the known
 * ones, so a row written by a newer CLI or worker can still be found.
 */
export const AuditActionFilterSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

/** `AuditLog.actorType` values in use (a CHECK follows in the phase 9 migration, D-63 (9)). */
export const AUDIT_ACTOR_TYPES = ['ADMIN', 'CLI', 'SYSTEM'] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;
