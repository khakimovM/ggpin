import { Injectable } from '@nestjs/common';
import type { AdminUser, Prisma } from '@repo/db';
import { ADMIN_SESSION_IDLE_SEC, type AdminAuditAction, type AdminRole } from '@repo/shared';
import type { Db } from '../../../infra/prisma/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';

/** One AuditLog row of the admin surface (panel: actor ADMIN; owner CLI: actor CLI, no id). */
export interface AdminAuditData {
  /** A panel write's row id is its Idempotency-Key row (`actor.request.auditId`); else a new id. */
  readonly id?: string;
  readonly actorType: 'ADMIN' | 'CLI';
  readonly actorId: string | null;
  readonly action: AdminAuditAction;
  readonly targetType: 'AdminUser' | 'AdminSession';
  readonly targetId: string;
  readonly before: Prisma.InputJsonValue | null;
  readonly after: Prisma.InputJsonValue;
  readonly reason: string | null;
  /** The full client address (the audit row is the one place it is kept, docs/04 «Audit log»). */
  readonly ip: string | null;
}

export interface NewAdmin {
  readonly telegramId: bigint;
  readonly name: string;
  readonly role: AdminRole;
}

/** An active OWNER row locked by lockActiveOwners. */
export interface OwnerRow {
  readonly id: string;
  readonly telegramId: bigint;
}

export interface AdminListRow extends AdminUser {
  readonly activeSessions: number;
}

export interface AdminAccountRow extends AdminListRow {
  /** The newest session it opened (a session = one login); null: never signed in. */
  readonly lastLoginAt: Date | null;
}

/** What the panel may change on a non-OWNER admin row (`PATCH /admin/admins/:id`). */
export interface PanelAdminChange {
  readonly name?: string;
  readonly role?: 'OPERATOR' | 'SUPPORT';
  readonly isActive?: boolean;
}

/** A live session: not revoked, not past `expiresAt`, used within the idle hour (isSessionLive). */
function liveSessionWhere(now: Date) {
  const idleSince = new Date(now.getTime() - ADMIN_SESSION_IDLE_SEC * 1000);
  return { revokedAt: null, expiresAt: { gt: now }, lastUsedAt: { gt: idleSince } };
}

// All Prisma access to AdminUser and the admin AuditLog rows. Writes take the caller's
// transaction: every change is ONE transaction with its AuditLog row.
@Injectable()
export class AdminUsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  findById(id: string, db: Db = this.prisma.client): Promise<AdminUser | null> {
    return db.adminUser.findUnique({ where: { id } });
  }

  findByTelegramId(telegramId: bigint, db: Db = this.prisma.client): Promise<AdminUser | null> {
    return db.adminUser.findUnique({ where: { telegramId } });
  }

  create(tx: Db, admin: NewAdmin): Promise<AdminUser> {
    return tx.adminUser.create({ data: { ...admin, isActive: true } });
  }

  /** active -> inactive; false when the row was already inactive (or is gone). */
  async deactivate(tx: Db, id: string): Promise<boolean> {
    const { count } = await tx.adminUser.updateMany({
      where: { id, isActive: true },
      data: { isActive: false },
    });
    return count === 1;
  }

  /** inactive -> active; false when the row was already active (or is gone). */
  async reactivate(tx: Db, id: string): Promise<boolean> {
    const { count } = await tx.adminUser.updateMany({
      where: { id, isActive: false },
      data: { isActive: true },
    });
    return count === 1;
  }

  /** `from` -> `to`; false when the role is no longer `from` (a parallel change won). */
  async setRole(tx: Db, id: string, from: AdminRole, to: AdminRole): Promise<boolean> {
    const { count } = await tx.adminUser.updateMany({
      where: { id, role: from },
      data: { role: to },
    });
    return count === 1;
  }

  /**
   * Locks every active OWNER row (id order, so two callers never deadlock) for the rest of the
   * transaction and returns them: the "last OWNER" rule counts them under the lock, so two
   * parallel changes can never both remove "the other" owner. A row that stopped being an active
   * OWNER while we waited is skipped (Postgres re-checks the WHERE after the wait).
   */
  lockActiveOwners(tx: Db): Promise<OwnerRow[]> {
    return tx.$queryRaw<OwnerRow[]>`
      SELECT "id", "telegramId" FROM "AdminUser"
      WHERE "role" = 'OWNER' AND "isActive" = true
      ORDER BY "id"
      FOR UPDATE`;
  }

  /**
   * The admin's row under a share lock for the rest of the transaction, read after the lock: a
   * login that opens a session sees a deactivation or role change that committed while it waited,
   * and one that has not started yet waits for the login to commit (and then ends its session).
   */
  async lockForLogin(tx: Db, id: string): Promise<AdminUser | null> {
    await tx.$queryRaw`SELECT "id" FROM "AdminUser" WHERE "id" = ${id} FOR SHARE`;
    return tx.adminUser.findUnique({ where: { id } });
  }

  /**
   * The panel's admin-management lock on the TARGET row (plan S9a), taken after the acting admin's
   * FOR SHARE (confirmActorInTx) and before any session row: `UPDATE` for a change of the row
   * itself (a login's FOR SHARE waits for it, as for the CLI), `SHARE` for a revoke that only ends
   * sessions (two OWNERs revoking each other's sessions at once must not deadlock on an upgrade).
   * Read after the lock. Never lockActiveOwners: the panel never changes an OWNER row.
   */
  async lockById(tx: Db, id: string, mode: 'UPDATE' | 'SHARE'): Promise<AdminUser | null> {
    if (mode === 'UPDATE') {
      await tx.$queryRaw`SELECT "id" FROM "AdminUser" WHERE "id" = ${id} FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT "id" FROM "AdminUser" WHERE "id" = ${id} FOR SHARE`;
    }
    return tx.adminUser.findUnique({ where: { id } });
  }

  /**
   * The panel's change of a non-OWNER row: false when the row is an OWNER (or gone). The service
   * has refused an OWNER under the lock already; the guard in the WHERE keeps the rule in SQL too.
   */
  async updateNonOwner(tx: Db, id: string, data: PanelAdminChange): Promise<boolean> {
    const { count } = await tx.adminUser.updateMany({
      where: { id, role: { not: 'OWNER' } },
      data,
    });
    return count === 1;
  }

  /** One admin as `AdminAccount` needs it: live sessions now and the newest login. */
  async account(
    id: string,
    now: Date,
    db: Db = this.prisma.client,
  ): Promise<AdminAccountRow | null> {
    const row = await db.adminUser.findUnique({
      where: { id },
      include: { _count: { select: { sessions: { where: liveSessionWhere(now) } } } },
    });
    if (row === null) return null;
    const newest = await db.adminSession.aggregate({
      where: { adminId: id },
      _max: { createdAt: true },
    });
    const { _count, ...admin } = row;
    return { ...admin, activeSessions: _count.sessions, lastLoginAt: newest._max.createdAt };
  }

  /** Telegram ids of every active admin (the allowlist decides who of them can sign in). */
  async activeTelegramIds(tx: Db): Promise<bigint[]> {
    const rows = await tx.adminUser.findMany({
      where: { isActive: true },
      select: { telegramId: true },
    });
    return rows.map((r) => r.telegramId);
  }

  /**
   * Every admin with the number of live sessions: not revoked, not past `expiresAt` and used
   * within the idle hour (the same three rules as isSessionLive).
   */
  async list(now: Date): Promise<AdminListRow[]> {
    const rows = await this.prisma.client.adminUser.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { sessions: { where: liveSessionWhere(now) } } } },
    });
    return rows.map(({ _count, ...admin }) => ({ ...admin, activeSessions: _count.sessions }));
  }

  async createAudit(tx: Db, data: AdminAuditData): Promise<string> {
    const row = await tx.auditLog.create({
      data: {
        ...(data.id === undefined ? {} : { id: data.id }),
        actorType: data.actorType,
        actorId: data.actorId,
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId,
        ...(data.before === null ? {} : { before: data.before }),
        after: data.after,
        reason: data.reason,
        ip: data.ip,
      },
      select: { id: true },
    });
    return row.id;
  }
}
