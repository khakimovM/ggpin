import { Injectable } from '@nestjs/common';
import type { Prisma, TonTransferStatus } from '@repo/db';
import { TON_TX_HINT_ACTION } from '@repo/shared';
import type { Db } from '../../../infra/prisma/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';

// All Prisma access of the owner's Z6 hint (`ton:hint`, phase 5 S9f, D-64 (7), Q-7). The hint is
// an AuditLog row (append-only, no migration): action TON_TX_HINT, targetType "TonTransfer",
// actorType CLI (the owner channel, D-46), the hinted transaction in `after`. The worker reads the
// latest row of a CONSUMED_UNMATCHED transfer and checks it on the chain; nothing else is written.
// Only rows the owner's CLI wrote count (`actorType CLI`, `after.actor` = CLI / OWNER: review F6).

export const TON_HINT_TARGET = 'TonTransfer';

/** The worker's verdict on a hint, kept on the attempt (`response.ton.hint`). */
export interface HintVerdict {
  readonly auditId: string;
  readonly verdict: string;
}

export interface HintTransfer {
  readonly id: string;
  readonly purpose: string;
  readonly status: TonTransferStatus;
  readonly seqno: number;
  readonly orderId: string | null;
  readonly verdict: HintVerdict | null;
}

/** A stored hint, as `order:show` prints it (the worker's verdict is on the attempt). */
export interface StoredHintRow {
  readonly id: string;
  readonly transferId: string;
  readonly txHash: string | null;
  readonly lt: string | null;
  readonly createdAt: Date;
}

export interface HintAuditInput {
  readonly transferId: string;
  readonly before: Prisma.InputJsonObject;
  readonly after: Prisma.InputJsonObject;
  readonly reason: string;
  readonly ip: string | null;
}

function objectOf(value: Prisma.JsonValue | undefined | null): Prisma.JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function textOf(after: Prisma.JsonValue | null, key: string): string | null {
  const value = objectOf(after)?.[key];
  return typeof value === 'string' ? value : null;
}

/** The row was written by the owner's CLI channel (CLI_OWNER_AUDIT_ACTOR in `after`). */
function byOwnerCli(after: Prisma.JsonValue | null): boolean {
  const actor = objectOf(objectOf(after)?.['actor']);
  return actor?.['type'] === 'CLI' && actor['role'] === 'OWNER';
}

function verdictOf(response: Prisma.JsonValue | null): HintVerdict | null {
  const hint = objectOf(objectOf(objectOf(response)?.['ton'])?.['hint']);
  const auditId = hint?.['auditId'];
  const verdict = hint?.['verdict'];
  return typeof auditId === 'string' && typeof verdict === 'string' ? { auditId, verdict } : null;
}

const HINT_ROWS = {
  action: TON_TX_HINT_ACTION,
  targetType: TON_HINT_TARGET,
  actorType: 'CLI',
} as const;

@Injectable()
export class TonHintRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  async transfer(tx: Db, transferId: string): Promise<HintTransfer | null> {
    const row = await tx.tonTransfer.findUnique({
      where: { id: transferId },
      select: {
        id: true,
        purpose: true,
        status: true,
        seqno: true,
        attempt: { select: { orderId: true, response: true } },
      },
    });
    if (row === null) return null;
    return {
      id: row.id,
      purpose: row.purpose,
      status: row.status,
      seqno: row.seqno,
      orderId: row.attempt?.orderId ?? null,
      verdict: verdictOf(row.attempt?.response ?? null),
    };
  }

  /** The transfer's latest hint (txHash and lt as stored), read inside the writing transaction. */
  async latestHint(tx: Db, transferId: string): Promise<StoredHintRow | null> {
    const rows = await tx.auditLog.findMany({
      where: { ...HINT_ROWS, targetId: transferId },
      select: { id: true, after: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const row = rows.find((r) => byOwnerCli(r.after));
    if (row === undefined) return null;
    const { id, after, createdAt } = row;
    return { id, transferId, txHash: textOf(after, 'txHash'), lt: textOf(after, 'lt'), createdAt };
  }

  /** The owner's hints of these transfers, newest first. */
  async hintsOf(transferIds: readonly string[]): Promise<StoredHintRow[]> {
    if (transferIds.length === 0) return [];
    const rows = await this.prisma.client.auditLog.findMany({
      where: { ...HINT_ROWS, targetId: { in: [...transferIds] } },
      select: { id: true, targetId: true, after: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows
      .filter((row) => byOwnerCli(row.after))
      .map((row) => ({
        id: row.id,
        transferId: row.targetId,
        txHash: textOf(row.after, 'txHash'),
        lt: textOf(row.after, 'lt'),
        createdAt: row.createdAt,
      }));
  }

  /** The CLI's hint row: `actorType CLI`, no actor id, the operator in `after` (D-46). */
  createHint(tx: Db, data: HintAuditInput): Promise<{ id: string }> {
    return tx.auditLog.create({
      data: {
        actorType: 'CLI',
        actorId: null,
        action: TON_TX_HINT_ACTION,
        targetType: TON_HINT_TARGET,
        targetId: data.transferId,
        before: data.before,
        after: data.after,
        reason: data.reason,
        ip: data.ip,
      },
      select: { id: true },
    });
  }
}
