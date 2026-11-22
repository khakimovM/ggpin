import { Injectable } from '@nestjs/common';
import { lockWallet, type Prisma } from '@repo/db';
import type { Db } from '../../../infra/prisma/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';

export interface UserFlags {
  readonly isBlocked: boolean;
  readonly purchaseFrozen: boolean;
}

export interface UserActionAudit {
  readonly id: string;
  readonly actorId: string;
  readonly ip: string | null;
  readonly action: string;
  readonly targetId: string;
  readonly before?: Prisma.InputJsonValue;
  readonly after: Prisma.InputJsonValue;
  readonly reason?: string;
}

/** Writes of the admin's user actions (block, unblock, freeze, sessions, notes; D-63 (9)). */
@Injectable()
export class AdminUserActionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The root client, for a read outside any transaction. */
  client(): Db {
    return this.prisma.client;
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  /** The user's Wallet row FOR UPDATE: the lock every purchase and money movement takes. */
  lockWallet(tx: Db, userId: string): Promise<void> {
    return lockWallet(tx, userId);
  }

  flags(tx: Db, userId: string): Promise<UserFlags | null> {
    return tx.user.findUnique({
      where: { id: userId },
      select: { isBlocked: true, purchaseFrozen: true },
    });
  }

  /** False when the flag already had that value (nothing written). */
  async setBlocked(tx: Db, userId: string, isBlocked: boolean): Promise<boolean> {
    const { count } = await tx.user.updateMany({
      where: { id: userId, isBlocked: !isBlocked },
      data: { isBlocked },
    });
    return count === 1;
  }

  async freeze(tx: Db, userId: string): Promise<boolean> {
    const { count } = await tx.user.updateMany({
      where: { id: userId, purchaseFrozen: false },
      data: { purchaseFrozen: true },
    });
    return count === 1;
  }

  /**
   * Ends every live web session of the user in the caller's transaction. Each family is taken
   * under the advisory lock WebSessionRepository.lockFamily uses (same key), in a fixed order,
   * so a refresh rotating one of them either committed before (its new row is ended here) or
   * waits and then finds its row revoked.
   */
  async revokeWebSessions(tx: Db, userId: string, now: Date): Promise<number> {
    const families = await tx.webSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    for (const familyId of families.map((f) => f.familyId).sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ws-family:${familyId}`}, 0))`;
    }
    const { count } = await tx.webSession.updateMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    return count;
  }

  async createAudit(tx: Db, data: UserActionAudit): Promise<string> {
    const row = await tx.auditLog.create({
      data: {
        id: data.id,
        actorType: 'ADMIN',
        actorId: data.actorId,
        ip: data.ip,
        action: data.action,
        targetType: 'User',
        targetId: data.targetId,
        ...(data.before === undefined ? {} : { before: data.before }),
        after: data.after,
        ...(data.reason === undefined ? {} : { reason: data.reason }),
      },
      select: { id: true },
    });
    return row.id;
  }
}
