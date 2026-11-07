import { Injectable } from '@nestjs/common';
import {
  appendLedgerEntry,
  lockWallet,
  sumBalance,
  type LedgerEntry,
  type LedgerEntryInput,
  type LedgerKind,
  type LedgerRefType,
  type Payment,
  type Prisma,
} from '@repo/db';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface LedgerPageQuery {
  readonly kind?: LedgerKind;
  readonly page: number;
  readonly limit: number;
}

export interface LedgerPage {
  readonly rows: readonly LedgerEntry[];
  readonly total: number;
}

export interface EntryKey {
  readonly userId: string;
  readonly refType: LedgerRefType;
  readonly refId: string;
  readonly kind: LedgerKind;
}

export interface AuditEntryData {
  /** Optional caller-chosen id: a retried CLI command reuses it, which makes the write idempotent. */
  readonly id?: string;
  readonly ip: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly before: Prisma.InputJsonValue;
  readonly after: Prisma.InputJsonValue;
  readonly reason: string;
}

export interface AuditRef {
  readonly id: string;
  readonly reason: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
}

// All Prisma access of the wallet module. The ledger helpers of @repo/db are wrapped here so the
// service never touches a Prisma client, and so each one is handed the transaction client.
@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  /** A plain (unlocked) balance read: enough to show a balance, never to decide a write. */
  balance(userId: string, db: Db = this.prisma.client): Promise<bigint> {
    return sumBalance(db, userId);
  }

  /** Serialises the user's money movements until `tx` ends; throws WalletNotFoundError. */
  lock(tx: Db, userId: string): Promise<void> {
    return lockWallet(tx, userId);
  }

  appendEntry(tx: Db, entry: LedgerEntryInput): Promise<{ id: string }> {
    return appendLedgerEntry(tx, entry);
  }

  /** The user's own entries, newest first; `id` breaks ties so pages never overlap. */
  async listLedger(userId: string, query: LedgerPageQuery): Promise<LedgerPage> {
    const where: Prisma.LedgerEntryWhereInput = {
      userId,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
    };
    const [rows, total] = await this.prisma.client.$transaction([
      this.prisma.client.ledgerEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.client.ledgerEntry.count({ where }),
    ]);
    return { rows, total };
  }

  findPayment(paymentId: string, db: Db = this.prisma.client): Promise<Payment | null> {
    return db.payment.findUnique({ where: { id: paymentId } });
  }

  /** One entry by its idempotency key, scoped to the owner. */
  findEntry(tx: Db, key: EntryKey): Promise<LedgerEntry | null> {
    return tx.ledgerEntry.findFirst({
      where: { userId: key.userId, refType: key.refType, refId: key.refId, kind: key.kind },
    });
  }

  /** CONFIRMED -> CANCELLED; returns false when the payment was not CONFIRMED any more. */
  async cancelConfirmedPayment(tx: Db, paymentId: string, at: Date): Promise<boolean> {
    const { count } = await tx.payment.updateMany({
      where: { id: paymentId, status: 'CONFIRMED' },
      data: { status: 'CANCELLED', cancelledAt: at },
    });
    return count === 1;
  }

  findAudit(tx: Db, id: string): Promise<AuditRef | null> {
    return tx.auditLog.findUnique({
      where: { id },
      select: { id: true, reason: true, action: true, targetType: true, targetId: true },
    });
  }

  findAuditByTarget(
    tx: Db,
    action: string,
    targetType: string,
    targetId: string,
  ): Promise<AuditRef | null> {
    return tx.auditLog.findFirst({
      where: { action, targetType, targetId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, reason: true, action: true, targetType: true, targetId: true },
    });
  }

  async createAudit(tx: Db, data: AuditEntryData): Promise<{ id: string }> {
    return tx.auditLog.create({
      data: {
        ...(data.id === undefined ? {} : { id: data.id }),
        // The owner CLI is not a user session: no actor id, the operator name is in `after`.
        actorType: 'CLI',
        actorId: null,
        ip: data.ip,
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId,
        before: data.before,
        after: data.after,
        reason: data.reason,
      },
      select: { id: true },
    });
  }

  /**
   * Sets the flag and says whether THIS call flipped it (false -> true). Only the flip may raise
   * the walletFrozen alert. The flag is never cleared here: unfreezing is an owner decision
   * (unfreeze: S8 CLI).
   */
  async freezePurchases(tx: Db, userId: string): Promise<boolean> {
    const { count } = await tx.user.updateMany({
      where: { id: userId, purchaseFrozen: false },
      data: { purchaseFrozen: true },
    });
    return count === 1;
  }

  /** Clears the flag (owner CLI `user:unfreeze`, D-41); false when it was not set. */
  async unfreezePurchases(tx: Db, userId: string): Promise<boolean> {
    const { count } = await tx.user.updateMany({
      where: { id: userId, purchaseFrozen: true },
      data: { purchaseFrozen: false },
    });
    return count === 1;
  }

  async isPurchaseFrozen(tx: Db, userId: string): Promise<boolean> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { purchaseFrozen: true },
    });
    return user?.purchaseFrozen ?? false;
  }
}

/** A unique index refused the write (Prisma P2002), e.g. a reused AuditLog id. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
