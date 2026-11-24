import type { AdminWriteKeyVoidBody, AdminWriteKeyVoidResponse } from '@repo/shared';
import { expectedAuditId } from '../lib/idempotency-outcome';

type Applied = Extract<AdminWriteKeyVoidResponse, { status: 'APPLIED' }>;

const AT = '2026-11-24T09:00:00.000Z';

/**
 * A key void answer the way the API gives it: the audit row id is the key's own (SA L-1, the panel
 * refuses any other). `adminId` is the signed-in admin of the action that sent the key.
 */
export async function voidAnswer(
  adminId: string,
  body: AdminWriteKeyVoidBody,
  status: 'APPLIED' | 'VOIDED',
  action: Applied['action'] = 'USER_BLOCK',
): Promise<AdminWriteKeyVoidResponse> {
  const auditId = await expectedAuditId(adminId, body.idempotencyKey);
  return status === 'APPLIED' ? { status, auditId, action, at: AT } : { status, auditId, at: AT };
}
