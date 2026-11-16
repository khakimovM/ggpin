import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@repo/db';
import { RECONCILE_BATCH_LIMIT } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { PrismaHolder } from '../../ton/ton-transfer.repository';
import type { ReviewAttempt } from './review-evidence';

// The order reconciler's reads (phase 5 S9). Nothing here writes: the TON module writes chain
// facts, `resolveNeedsReview` writes a resolution (review-resolver.ts). Every list is bounded by
// RECONCILE_BATCH_LIMIT (<= 100) and ordered oldest first.

/** An ORDER transfer still waiting for the chain (SIGNED or BROADCAST). */
export interface PendingTransfer {
  readonly id: string;
  readonly network: string;
  readonly walletAddress: string;
  /** The order the transfer pays for; null only for a row that breaks the ORDER check. */
  readonly orderId: string | null;
}

/** Where the keyset walk over the review queue stopped. */
export interface ReviewCursor {
  readonly createdAt: Date;
  readonly id: string;
}

const PAYOUT_SELECT = {
  id: true,
  status: true,
  response: true,
  tonTransfer: {
    select: {
      id: true,
      purpose: true,
      network: true,
      walletAddress: true,
      seqno: true,
      validUntil: true,
      extMsgHash: true,
      status: true,
      txHash: true,
      txLt: true,
    },
  },
} as const;

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), RECONCILE_BATCH_LIMIT));
}

/** The order's attempts with their TON transfers, read through any client or transaction. */
export async function readReviewPayout(
  db: Pick<Tx, 'fulfillmentAttempt'>,
  orderId: string,
): Promise<ReviewAttempt[]> {
  const rows = await db.fulfillmentAttempt.findMany({
    where: { orderId },
    select: PAYOUT_SELECT,
    orderBy: { attemptNo: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    response: row.response,
    transfer: row.tonTransfer,
  }));
}

@Injectable()
export class OrderReconcileRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  /** The database clock, epoch ms: every reconciler window is measured on it (D-64). */
  async databaseNowMs(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ ms: string }[]>`
      SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS "ms"`;
    const ms = Number(rows[0]?.ms);
    if (!Number.isSafeInteger(ms)) throw new Error('the database clock could not be read');
    return ms;
  }

  /** Unresolved ORDER transfers, oldest first (SELFTEST rows are the CLI's, never looked at). */
  async pendingTransfers(limit: number): Promise<PendingTransfer[]> {
    const rows = await this.prisma.client.tonTransfer.findMany({
      where: { purpose: 'ORDER', status: { in: ['SIGNED', 'BROADCAST'] } },
      select: {
        id: true,
        network: true,
        walletAddress: true,
        attempt: { select: { orderId: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: boundedLimit(limit),
    });
    return rows.map((row) => ({
      id: row.id,
      network: row.network,
      walletAddress: row.walletAddress,
      orderId: row.attempt?.orderId ?? null,
    }));
  }

  /** NEEDS_REVIEW orders after the cursor, oldest first (the `status, createdAt` index). */
  async reviewPage(after: ReviewCursor | null, limit: number): Promise<ReviewCursor[]> {
    return this.prisma.client.order.findMany({
      where: {
        status: 'NEEDS_REVIEW',
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }),
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: boundedLimit(limit),
    });
  }

  /** The order's attempts and transfers as they are now (outside any lock: a first look). */
  payoutOf(orderId: string): Promise<ReviewAttempt[]> {
    return readReviewPayout(this.prisma.client, orderId);
  }
}
