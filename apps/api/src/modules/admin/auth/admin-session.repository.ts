import { Injectable } from '@nestjs/common';
import type { AdminSession, AdminUser } from '@repo/db';
import type { Db } from '../../../infra/prisma/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';

export interface NewAdminSession {
  readonly adminId: string;
  /** sha256 (hex) of the cookie token; the token itself is never stored. */
  readonly tokenHash: string;
  /** Masked (IPv4 /24, IPv6 /48): the session list only has to be recognisable. */
  readonly ipMasked: string | null;
  readonly now: Date;
  readonly expiresAt: Date;
}

export type AdminSessionWithAdmin = AdminSession & { readonly admin: AdminUser };

// All Prisma access to AdminSession. Revocations are guarded `updateMany`s (revokedAt IS NULL),
// so a parallel logout, deactivation or bot "this was not me" ends a session exactly once.
@Injectable()
export class AdminSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(tx: Db, session: NewAdminSession): Promise<string> {
    const row = await tx.adminSession.create({
      data: {
        adminId: session.adminId,
        tokenHash: session.tokenHash,
        ip: session.ipMasked,
        lastUsedAt: session.now,
        expiresAt: session.expiresAt,
        createdAt: session.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** The session and its admin by token hash; the caller decides whether it is still live. */
  findByTokenHash(tokenHash: string): Promise<AdminSessionWithAdmin | null> {
    return this.prisma.client.adminSession.findUnique({
      where: { tokenHash },
      include: { admin: true },
    });
  }

  findById(id: string, db: Db = this.prisma.client): Promise<AdminSessionWithAdmin | null> {
    return db.adminSession.findUnique({ where: { id }, include: { admin: true } });
  }

  /**
   * Moves `lastUsedAt` to `now` only when it is older than `staleBefore`: at most one write per
   * session per minute, however many requests the panel sends.
   */
  async touch(id: string, now: Date, staleBefore: Date): Promise<void> {
    await this.prisma.client.adminSession.updateMany({
      where: { id, revokedAt: null, lastUsedAt: { lt: staleBefore } },
      data: { lastUsedAt: now },
    });
  }

  /** Ends one session; false when it was already ended. */
  async revoke(tx: Db, id: string, now: Date): Promise<boolean> {
    const { count } = await tx.adminSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
    return count === 1;
  }

  /** Ends every session of one admin that is not ended yet; returns how many. */
  async revokeAllOf(tx: Db, adminId: string, now: Date): Promise<number> {
    const { count } = await tx.adminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: now },
    });
    return count;
  }
}
