import { adminMayPerform } from '@repo/shared';
import type { Db } from '../../infra/prisma/db';
import { AppError } from '../exceptions/app-error';
import { assertWithinDeadline } from './admin-deadline';
import { isActorTransaction } from './admin-transaction';
import { isAdminActor, type CheckedAuditActor } from './audit-actor';
import { adminSessionOpen, lockAdminActor } from './audit-actor.repository';

/** What every audit row of the action carries about its actor, besides the columns. */
export type ActorAfter =
  | { readonly operator: string; readonly osUser: string | null }
  | { readonly adminRole: string; readonly requestHash: string; readonly sessionId: string };

/**
 * The first step of every transaction that acts for an AuditActor (S2-6). The CLI is the owner
 * on the server: nothing to re-read. An admin is re-read under FOR SHARE: still active, the role
 * read NOW still holds the route's permission, and the session is still open; otherwise the
 * action is refused with the admin surface's one answer (404, D-26) and nothing is written. The
 * returned `adminRole` is that fresh role (never the session's cached one, p5 S9b L-1).
 * An admin past its request deadline is refused first, before any lock (docs/04 «So‘rov
 * deadline’i», point 2): 503 ADMIN_DEADLINE_EXCEEDED, the transaction rolls back.
 */
export async function confirmActorInTx(
  tx: Db,
  actor: CheckedAuditActor,
  now: Date,
): Promise<ActorAfter> {
  if (!isAdminActor(actor)) return { operator: actor.operator, osUser: actor.osUser };
  // A server bug, never a client's: an admin action must run in runActorTransaction (point 3).
  if (!isActorTransaction(tx)) throw new AppError('INTERNAL_ERROR');
  assertWithinDeadline(actor.deadline);
  const admin = await lockAdminActor(tx, actor.adminId);
  if (
    admin === null ||
    !admin.isActive ||
    !adminMayPerform(admin.role, actor.permission) ||
    !(await adminSessionOpen(tx, actor.sessionId, actor.adminId, now))
  ) {
    throw new AppError('NOT_FOUND');
  }
  // The session too (SA-S6-12): which sign-in did it, for a revoke after a stolen session.
  return {
    adminRole: admin.role,
    requestHash: actor.request.requestHash,
    sessionId: actor.sessionId,
  };
}
