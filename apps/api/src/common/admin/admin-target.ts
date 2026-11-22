import type { Db } from '../../infra/prisma/db';
import { validationError } from './admin-input';
import { isAdminActor, type CheckedAuditActor } from './audit-actor';
import { isAdminsOwnUser } from './admin-target.repository';

/** The reason an admin's money to its own store account is refused (owner decision 2026-11-18). */
export const SELF_TARGET_REASON = 'SELF_TARGET';

/**
 * SA-S6-9: the panel never puts money into the acting admin's own wallet (adjust, review
 * credit). Checked in the transaction, before any write; the CLI (the owner on the server) is not
 * restricted. Answer: `400 fields[{ path: 'userId', code: 'SELF_TARGET' }]`.
 */
export async function refuseSelfTarget(
  tx: Db,
  actor: CheckedAuditActor,
  userId: string,
): Promise<void> {
  if (!isAdminActor(actor)) return;
  if (await isAdminsOwnUser(tx, actor.adminId, userId)) {
    throw validationError('userId', SELF_TARGET_REASON);
  }
}
