import { Injectable } from '@nestjs/common';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface NewSessionRow {
  readonly userId: string;
  readonly familyId: string;
  readonly refreshHash: string;
  readonly userAgent: string | null;
  /** Already masked (see mask-ip.ts); the raw address is never stored. */
  readonly ip: string | null;
  readonly expiresAt: Date;
  /** The injected clock's now, not the DB default: lastUsedAt is read from these timestamps. */
  readonly createdAt: Date;
}

export interface RotatedRow {
  readonly userId: string;
  readonly familyId: string;
}

export interface RefreshRowState {
  readonly userId: string;
  readonly familyId: string;
  readonly revokedAt: Date | null;
}

/** A session family of one user; named fields because two bare strings are easy to swap. */
export interface FamilyRef {
  readonly userId: string;
  readonly familyId: string;
}

export interface ActiveSessionRow {
  readonly familyId: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface FamilyBounds {
  readonly familyId: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
}

// All Prisma access for web sessions. One row per refresh token; rows of one login share a
// familyId (the "session" the user sees). Methods take an optional `db` so the service can group
// them into one `$transaction` without importing Prisma.
@Injectable()
export class WebSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  /**
   * Whether the session family (the `sid` of an access token) still has a live refresh row for
   * this user. Scoped by userId too, so a token can never vouch for another user's family.
   * `now` is passed in (the injectable clock), never SQL now().
   */
  async isFamilyActive(ref: FamilyRef, now: Date): Promise<boolean> {
    const { familyId, userId } = ref;
    const row = await this.prisma.client.webSession.findFirst({
      where: { familyId, userId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    return row !== null;
  }

  async insert(data: NewSessionRow, db: Db = this.prisma.client): Promise<void> {
    await db.webSession.create({ data });
  }

  /**
   * Atomically retires a live refresh row: the single UPDATE decides who wins when the same
   * token is presented twice at once. Returns the row's owner, or null when the token was not
   * live (unknown, already used, revoked or expired).
   */
  async revokeLiveByHash(
    refreshHash: string,
    now: Date,
    db: Db = this.prisma.client,
  ): Promise<RotatedRow | null> {
    const { count } = await db.webSession.updateMany({
      where: { refreshHash, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    if (count !== 1) return null;
    // We hold the row lock until commit, so this reads the row we just retired.
    return db.webSession.findUnique({
      where: { refreshHash },
      select: { userId: true, familyId: true },
    });
  }

  findByHash(refreshHash: string): Promise<RefreshRowState | null> {
    return this.prisma.client.webSession.findUnique({
      where: { refreshHash },
      select: { userId: true, familyId: true, revokedAt: true },
    });
  }

  /** Revokes every live row of the user's family; returns how many were live (0 = not theirs). */
  async revokeFamily(
    ref: FamilyRef & { readonly now: Date },
    db: Db = this.prisma.client,
  ): Promise<number> {
    const { familyId, userId, now } = ref;
    const { count } = await db.webSession.updateMany({
      where: { familyId, userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return count;
  }

  /** The live row of each active family of the user, newest first. */
  listActive(userId: string, now: Date, limit: number): Promise<ActiveSessionRow[]> {
    return this.prisma.client.webSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { familyId: true, userAgent: true, ip: true },
    });
  }

  /** First row = when the session started, newest row = its last rotation (last use). */
  async familyBounds(userId: string, familyIds: readonly string[]): Promise<FamilyBounds[]> {
    if (familyIds.length === 0) return [];
    const groups = await this.prisma.client.webSession.groupBy({
      by: ['familyId'],
      where: { userId, familyId: { in: [...familyIds] } },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    return groups.flatMap((g) =>
      g._min.createdAt !== null && g._max.createdAt !== null
        ? [{ familyId: g.familyId, createdAt: g._min.createdAt, lastUsedAt: g._max.createdAt }]
        : [],
    );
  }
}
