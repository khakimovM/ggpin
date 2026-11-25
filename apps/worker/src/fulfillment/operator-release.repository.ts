import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import {
  ORDER_EFFECTS_ACTIONS,
  OrderRetryAuditAfterSchema,
  OrderRetryAuditBeforeSchema,
  type NumberedAttemptRow,
} from '@repo/shared';
import { PrismaService } from '../infra/prisma/prisma.service';

// Where the attempt count of an order starts again (phase 5 S9b, D-64 (5), D-66 (2)). Only the
// OWNER's release (`ORDER_RETRY` audit row) does that: the owner CLI channel (actorType CLI, the
// owner's own channel, assertOwnerChannel) or, from phase 9, the panel with `after.actor.role`
// OWNER. An OPERATOR retry or a SYSTEM row resets nothing (Q-20): otherwise "EXPIRED -> a hold of
// another reason -> an operator retry" would walk around the cap and pay again on a single-source
// EXPIRED verdict. The row stores the highest attempt number at the release (`before.maxAttemptNo`,
// read under the order lock); only attempts numbered above it count.
//
// Fail-closed everywhere: no row, a row that is not the OWNER's, a number that does not parse, or
// a number above the order's own attempts (§13: a corrupt or forged row) gives null, and null
// counts EVERY attempt: the order is held sooner, never paid twice.

/** OPERATOR rows newer than the last OWNER row that are looked through before giving up (null). */
const RELEASE_SCAN_LIMIT = 50;

/** The part of an `ORDER_RETRY` audit row this rule reads. */
export interface ReleaseRow {
  readonly actorType: string;
  readonly before: Prisma.JsonValue | null;
  readonly after: Prisma.JsonValue | null;
}

/**
 * The CLI owner channel (actorType CLI), or the panel's OWNER: actorType ADMIN AND an `after.actor`
 * of the shared shape that says ADMIN / OWNER (CR L2: an ADMIN row whose actor claims CLI is not
 * the owner channel). Any other actor (OPERATOR, SYSTEM, unknown, a mixed row): no.
 */
export function isOwnerRelease(row: ReleaseRow): boolean {
  if (row.actorType === 'CLI') return true;
  if (row.actorType !== 'ADMIN') return false;
  const after = OrderRetryAuditAfterSchema.safeParse(row.after);
  return after.success && after.data.actor.type === 'ADMIN' && after.data.actor.role === 'OWNER';
}

/** `before.maxAttemptNo` of the row (the shared shape), or null when it does not parse. */
export function releasedAfterOf(row: ReleaseRow): number | null {
  const parsed = OrderRetryAuditBeforeSchema.safeParse(row.before);
  return parsed.success ? parsed.data.maxAttemptNo : null;
}

/**
 * The release as the cap may use it: null when it names an attempt the order does not have (§13).
 * A release covers only attempts that existed when it was written, so its number can never be
 * above the order's highest attemptNo.
 */
export function clampRelease(
  releasedAfterAttemptNo: number | null,
  attempts: readonly NumberedAttemptRow[],
): number | null {
  if (releasedAfterAttemptNo === null) return null;
  const highest = attempts.reduce((max, attempt) => Math.max(max, attempt.attemptNo), 0);
  return releasedAfterAttemptNo > highest ? null : releasedAfterAttemptNo;
}

@Injectable()
export class OperatorReleaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `before.maxAttemptNo` of the order's latest OWNER release, or null (count every attempt). Read
   * only. The newest rows first (createdAt, then id); OPERATOR rows on top are skipped.
   */
  async lastOwnerRelease(orderId: string): Promise<number | null> {
    const rows = await this.prisma.client.auditLog.findMany({
      where: {
        action: ORDER_EFFECTS_ACTIONS.retry,
        targetType: 'Order',
        targetId: orderId,
        actorType: { not: 'SYSTEM' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RELEASE_SCAN_LIMIT,
      select: { actorType: true, before: true, after: true },
    });
    const owner = rows.find(isOwnerRelease);
    return owner === undefined ? null : releasedAfterOf(owner);
  }
}
