import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import type { Db } from '../../../infra/prisma/db';
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

/** The tombstone of a voided key (docs/04 «Kalitni bekor qilish»): no key, no request hash. */
export interface AdminTombstone {
  readonly id: string;
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly after: Prisma.InputJsonValue;
  readonly ip: string | null;
}

const AUDIT_ROW = {
  id: true,
  actorType: true,
  actorId: true,
  action: true,
  targetId: true,
  after: true,
  createdAt: true,
} as const;

/** What a replay of an admin write reads back (docs/04 «Admin» — `Idempotency-Key`). */
@Injectable()
export class AdminWriteRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAudit(id: string, db: Db = this.prisma.client): Promise<AdminAuditRow | null> {
    return db.auditLog.findUnique({ where: { id }, select: AUDIT_ROW });
  }

  transaction<T>(fn: (tx: Db) => Promise<T>, timeoutMs: number): Promise<T> {
    return this.prisma.client.$transaction(fn, { timeout: timeoutMs });
  }

  /**
   * INSERT ... ON CONFLICT DO NOTHING of the tombstone: true when this call wrote it. A row with
   * the same id that another transaction inserted and has not committed yet makes Postgres wait
   * for that transaction: its commit is a conflict (false), its rollback lets this insert in.
   */
  async insertTombstone(tx: Db, row: AdminTombstone): Promise<boolean> {
    const { count } = await tx.auditLog.createMany({
      data: [{ ...row, actorType: 'ADMIN', reason: null }],
      skipDuplicates: true,
    });
    return count === 1;
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
