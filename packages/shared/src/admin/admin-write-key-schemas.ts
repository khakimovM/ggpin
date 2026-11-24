// `POST /admin/write-keys/void` (docs/04 «Kalitni bekor qilish», 9-B SA-1): an admin voids one
// of its OWN Idempotency-Keys. The answer is decided by the key's audit row id (the primary key):
// either the action under that key committed (APPLIED) or it never will (VOIDED), nothing else.
import { z } from 'zod';
import { IdempotencyKeySchema, ResourceIdSchema } from '../common-schemas';
import { AuditActionFilterSchema, type AdminAuditAction } from './admin-audit-actions';
import { IsoDateTimeSchema } from './admin-common-schemas';
import type { AdminPermission } from './admin-permission-keys';

/**
 * The admin writes that take an `Idempotency-Key` (docs/04 «Admin»): every write of the matrix
 * except `confirmations.create` (issuing a code writes nothing) and the void itself. A test keeps
 * it equal to the matrix's writes minus those two.
 */
export const ADMIN_KEYED_WRITE_PERMISSIONS = Object.freeze([
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
] as const satisfies readonly AdminPermission[]);
export const AdminKeyedWritePermissionSchema = z.enum(ADMIN_KEYED_WRITE_PERMISSIONS);
export type AdminKeyedWritePermission = z.infer<typeof AdminKeyedWritePermissionSchema>;

/** `action` and `targetId` only label the tombstone in the audit log; the key alone decides. */
export const AdminWriteKeyVoidBodySchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema,
  action: AdminKeyedWritePermissionSchema,
  targetId: ResourceIdSchema,
});
export type AdminWriteKeyVoidBody = z.infer<typeof AdminWriteKeyVoidBodySchema>;

/** `AuditLog.action` of the tombstone a void writes under the key's audit id. */
export const IDEMPOTENCY_VOID_ACTION = 'IDEMPOTENCY_VOID' satisfies AdminAuditAction;

export const AdminWriteKeyVoidResponseSchema = z.discriminatedUnion('status', [
  // No action committed under the key: the tombstone (now or earlier) makes every later request
  // with it a 409 IDEMPOTENCY_CONFLICT.
  z.strictObject({
    status: z.literal('VOIDED'),
    auditId: ResourceIdSchema,
    at: IsoDateTimeSchema,
  }),
  // The action under the key committed: its own audit row, its `AuditLog.action` and time.
  z.strictObject({
    status: z.literal('APPLIED'),
    auditId: ResourceIdSchema,
    action: AuditActionFilterSchema,
    at: IsoDateTimeSchema,
  }),
]);
export type AdminWriteKeyVoidResponse = z.infer<typeof AdminWriteKeyVoidResponseSchema>;
