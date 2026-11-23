import type { AdminRole } from '@repo/db';
import type { Db } from '../../infra/prisma/db';

// The admin rows an admin money or account action re-reads INSIDE its transaction (S2-6 TOCTOU,
// D-63 (3)): plain functions on the caller's transaction, like @repo/db's lockWallet, so every
// service that takes an AuditActor can call them without a new constructor dependency.

export interface AdminActorRow {
  readonly id: string;
  readonly role: AdminRole;
  readonly isActive: boolean;
}

/**
 * The admin's row under a share lock until the transaction ends, taken FIRST (lock order
 * AdminUser -> wallet -> card/review/order). A deactivation or role change that committed while
 * we waited is seen; one that starts later waits for this action to commit. A transaction that
 * also writes AdminUser must use FOR NO KEY UPDATE instead (S2 SA I-2): none does here.
 */
export async function lockAdminActor(tx: Db, adminId: string): Promise<AdminActorRow | null> {
  const rows = await tx.$queryRaw<AdminActorRow[]>`
    SELECT "id", "role"::text AS "role", "isActive" FROM "AdminUser"
    WHERE "id" = ${adminId}
    FOR SHARE`;
  return rows[0] ?? null;
}

/**
 * The session still belongs to the admin, is not revoked and not past its absolute end. Read
 * without a lock: the guard's `lastUsedAt` touches must not wait for a money transaction. The
 * idle limit (ADMIN_SESSION_IDLE_SEC) is not re-checked here on purpose: AdminGuard checked it on
 * this very request a moment earlier, and an action must not fail half-way because the hour
 * ran out between the guard and its transaction (SA I-1).
 */
export async function adminSessionOpen(
  tx: Db,
  sessionId: string,
  adminId: string,
  now: Date,
): Promise<boolean> {
  const row = await tx.adminSession.findUnique({
    where: { id: sessionId },
    select: { adminId: true, revokedAt: true, expiresAt: true },
  });
  return (
    row !== null &&
    row.adminId === adminId &&
    row.revokedAt === null &&
    row.expiresAt.getTime() > now.getTime()
  );
}
