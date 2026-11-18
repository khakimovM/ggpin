import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import { LATE_WATCH_WINDOW_MS, TON_TX_HINT_ACTION, TonTxHintSchema } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { failedSuspectOf } from '../../ton/ton-late-facts';
import type { StoredHint } from '../../ton/ton-late.service';
import type { PrismaHolder } from '../../ton/ton-transfer.repository';
import type { WalletScope } from './order-reconcile.repository';

// The late-facts step's reads (phase 5 S9f): ORDER transfers of the worker's own hot wallet that
// may hold a late chain fact. Reads only (the TON module writes). Every list is a keyset page,
// oldest first, at most `limit` rows; the late watch window (LATE_WATCH_WINDOW_MS, 72 h on the
// database clock) bounds the two watches: from the transfer's creation, and for a CONFIRMED one
// also from its `confirmedAt` (a late CONFIRMED records the database clock of that write, so its
// bounce watch gets the full window, review F10). No order status is filtered there: a REFUNDED
// order (HELD_EXPIRED included, mainnet gate I-4) is watched too. A hint is read only from the
// owner's own CLI row (`actorType CLI`, `after.actor` = CLI / OWNER: review F6).

export interface LateItem {
  readonly transferId: string;
  readonly orderId: string;
}

export interface HintItem extends LateItem {
  readonly hint: StoredHint;
}

export interface ConfirmedItem extends LateItem {
  /** The transfer was found late (a `late` mark): its alert is re-queued (same id). */
  readonly late: boolean;
  /** A late bounce was recorded already: no more looks, its alert is re-queued (same id). */
  readonly lateBounce: boolean;
  /** The destination aborted / the transaction did not pay (F4): no more looks, the owner hears. */
  readonly lateDestination: boolean;
}

export interface LateCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface LatePage<T> {
  readonly items: readonly T[];
  /** Where the next page starts; null when this page reached the end (the walk wraps around). */
  readonly next: LateCursor | null;
}

const NOT_SENT = ['EXPIRED', 'CONSUMED_UNMATCHED'] as const;

const ROW = {
  id: true,
  createdAt: true,
  attempt: { select: { orderId: true, response: true } },
} as const;

type Row = Prisma.TonTransferGetPayload<{ select: typeof ROW }>;

function tonOf(response: Prisma.JsonValue | null): Prisma.JsonObject {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return {};
  const ton = response['ton'];
  return typeof ton === 'object' && ton !== null && !Array.isArray(ton) ? ton : {};
}

function hasFact(row: Row, key: string): boolean {
  const fact = tonOf(row.attempt?.response ?? null)[key];
  return fact !== undefined && fact !== null;
}

/** The audit id the TON module last decided a hint of this transfer for, or null. */
function decidedHint(row: Row): string | null {
  const hint = tonOf(row.attempt?.response ?? null)['hint'];
  if (typeof hint !== 'object' || hint === null || Array.isArray(hint)) return null;
  const auditId = hint['auditId'];
  return typeof auditId === 'string' ? auditId : null;
}

function objectOf(value: Prisma.JsonValue | undefined): Prisma.JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/** The hint row was written by the owner's CLI channel (CLI_OWNER_AUDIT_ACTOR in `after`). */
function byOwnerCli(after: Prisma.JsonObject | null): boolean {
  const actor = objectOf(after?.['actor']);
  return actor?.['type'] === 'CLI' && actor['role'] === 'OWNER';
}

/** A CONFIRMED transfer is watched 72 h from its creation, or from its (late) confirmation (F10). */
export function confirmedWatch(nowMs: number): Prisma.TonTransferWhereInput {
  const since = new Date(nowMs - LATE_WATCH_WINDOW_MS);
  return { OR: [{ createdAt: { gt: since } }, { confirmedAt: { gt: since } }] };
}

function after(cursor: LateCursor | null): Prisma.TonTransferWhereInput {
  if (cursor === null) return {};
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

function pageOf<T>(rows: readonly Row[], limit: number, items: readonly T[]): LatePage<T> {
  const last = rows[rows.length - 1];
  const next = rows.length < limit || last === undefined ? null : last;
  return { items, next: next === null ? null : { createdAt: next.createdAt, id: next.id } };
}

@Injectable()
export class LateFactsRepository {
  private readonly logger = new Logger(LateFactsRepository.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  private rows(where: Prisma.TonTransferWhereInput, limit: number): Promise<Row[]> {
    return this.prisma.client.tonTransfer.findMany({
      where,
      select: ROW,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  private ours(wallet: WalletScope): Prisma.TonTransferWhereInput {
    return { purpose: 'ORDER', network: wallet.network, walletAddress: wallet.rawAddress };
  }

  /** Unresolved transfers of NEEDS_REVIEW orders whose SUSPECT transaction sent nothing. */
  async failedSuspects(wallet: WalletScope, limit: number): Promise<LateItem[]> {
    const rows = await this.rows(
      {
        ...this.ours(wallet),
        status: { in: ['SIGNED', 'BROADCAST'] },
        attempt: { order: { status: 'NEEDS_REVIEW' } },
      },
      limit,
    );
    return rows.flatMap((row) =>
      row.attempt !== null && failedSuspectOf(row.attempt.response) !== null
        ? [{ transferId: row.id, orderId: row.attempt.orderId }]
        : [],
    );
  }

  /** CONSUMED_UNMATCHED transfers whose latest owner hint (CLI) is not decided yet. */
  async hintPage(wallet: WalletScope, cursor: LateCursor | null, limit: number) {
    const rows = await this.rows(
      { ...this.ours(wallet), status: 'CONSUMED_UNMATCHED', ...after(cursor) },
      limit,
    );
    const audits = await this.prisma.client.auditLog.findMany({
      where: {
        action: TON_TX_HINT_ACTION,
        targetType: 'TonTransfer',
        targetId: { in: rows.map((row) => row.id) },
        actorType: 'CLI',
      },
      select: { id: true, targetId: true, after: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const items: HintItem[] = [];
    for (const row of rows) {
      const latest = audits.find((audit) => audit.targetId === row.id);
      if (row.attempt === null || latest === undefined || decidedHint(row) === latest.id) continue;
      const stored = objectOf(latest.after);
      const parsed = TonTxHintSchema.safeParse({
        transferId: row.id,
        txHash: stored?.['txHash'],
        lt: stored?.['lt'],
      });
      if (!parsed.success || !byOwnerCli(stored)) {
        this.logger.error(`transfer ${row.id}: hint ${latest.id} unreadable or not the owner's`);
        continue;
      }
      const hint = { auditId: latest.id, txHash: parsed.data.txHash, lt: parsed.data.lt };
      items.push({ transferId: row.id, orderId: row.attempt.orderId, hint });
    }
    return pageOf(rows, limit, items);
  }

  /** EXPIRED / CONSUMED_UNMATCHED transfers inside the watch window, not found late yet. */
  async notSentPage(
    wallet: WalletScope,
    nowMs: number,
    cursor: LateCursor | null,
    limit: number,
  ): Promise<LatePage<LateItem>> {
    const rows = await this.rows(
      {
        ...this.ours(wallet),
        status: { in: [...NOT_SENT] },
        createdAt: { gt: new Date(nowMs - LATE_WATCH_WINDOW_MS) },
        ...after(cursor),
      },
      limit,
    );
    const items = rows.flatMap((row) =>
      row.attempt === null || hasFact(row, 'late')
        ? []
        : [{ transferId: row.id, orderId: row.attempt.orderId }],
    );
    return pageOf(rows, limit, items);
  }

  /** CONFIRMED transfers inside the watch window (a late bounce, the re-queued alerts). */
  async confirmedPage(
    wallet: WalletScope,
    nowMs: number,
    cursor: LateCursor | null,
    limit: number,
  ): Promise<LatePage<ConfirmedItem>> {
    const rows = await this.rows(
      {
        ...this.ours(wallet),
        status: 'CONFIRMED',
        AND: [confirmedWatch(nowMs), after(cursor)],
      },
      limit,
    );
    const items = rows.flatMap((row) =>
      row.attempt === null
        ? []
        : [
            {
              transferId: row.id,
              orderId: row.attempt.orderId,
              late: hasFact(row, 'late'),
              lateBounce: hasFact(row, 'lateBounce'),
              lateDestination: hasFact(row, 'lateDestination'),
            },
          ],
    );
    return pageOf(rows, limit, items);
  }
}
