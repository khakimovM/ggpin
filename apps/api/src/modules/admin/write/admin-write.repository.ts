import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';

export interface AdminAuditRow {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetId: string;
  readonly after: Prisma.JsonValue;
  readonly createdAt: Date;
}

/** What a replay of an admin write reads back (docs/04 «Admin» — `Idempotency-Key`). */
@Injectable()
export class AdminWriteRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAudit(id: string): Promise<AdminAuditRow | null> {
    return this.prisma.client.auditLog.findUnique({
      where: { id },
      select: {
        id: true,
        actorType: true,
        actorId: true,
        action: true,
        targetId: true,
        after: true,
        createdAt: true,
      },
    });
  }

  /** The ledger entry an action wrote (refType/refId/kind is unique, docs/03). */
  async ledgerEntryId(
    refType: 'ADMIN_ACTION' | 'PAYMENT',
    refId: string,
    kind: 'ADJUSTMENT' | 'TOPUP_REVERSAL',
  ): Promise<string | null> {
    const row = await this.prisma.client.ledgerEntry.findFirst({
      where: { refType, refId, kind },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async paymentUserId(paymentId: string): Promise<string | null> {
    const row = await this.prisma.client.payment.findUnique({
      where: { id: paymentId },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  /** The user's flags as they are now (a replay answers with the current state). */
  userFlags(userId: string): Promise<{ isBlocked: boolean; purchaseFrozen: boolean } | null> {
    return this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { isBlocked: true, purchaseFrozen: true },
    });
  }

  /** The wallet balance now: SUM of the user's ledger (docs/03, never a stored column). */
  async balance(userId: string): Promise<bigint> {
    const sum = await this.prisma.client.ledgerEntry.aggregate({
      where: { userId },
      _sum: { amountTiyin: true },
    });
    return sum._sum.amountTiyin ?? 0n;
  }

  /** The admin's display name (a note's author). */
  async adminName(adminId: string): Promise<string> {
    const row = await this.prisma.client.adminUser.findUnique({
      where: { id: adminId },
      select: { name: true },
    });
    return row?.name ?? '';
  }
}

/** A field of an audit row's `after` object, when it is there. */
export function afterField(row: AdminAuditRow, key: string): unknown {
  const after = row.after;
  if (typeof after !== 'object' || after === null || Array.isArray(after)) return undefined;
  return (after as Record<string, unknown>)[key];
}
