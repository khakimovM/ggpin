import { Inject, Injectable } from '@nestjs/common';
import { resolveNeedsReview, type ResolveNeedsReviewResult, type Tx } from '@repo/db';
import { ORDER_EFFECTS_ACTIONS } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { isDeadlock } from '../../ton/ton-db-errors';
import type { PrismaHolder } from '../../ton/ton-transfer.repository';
import { readReviewPayout } from './order-reconcile.repository';
import type { TonNotSentProof, TonTxProof } from './review-evidence';
import { evidenceKey } from './review-evidence';

// The reconciler's one write that moves money (phase 5 S9, plan §4.2): NEEDS_REVIEW -> DELIVERED
// (TON_TX) or -> FAILED + REFUND (TON_NOT_SENT), ONLY through `resolveNeedsReview`, which locks the
// wallet first (FAILED), then the order, binds the proof to the order's own rows, closes the
// attempts, runs the compare-and-set transition and the refund, and writes the audit row LAST, all
// in this one transaction. After it the evidence is read again under those locks: if a TON write
// changed it since the decision (a conflict, a suspect, another status), the transaction is rolled
// back and nothing happened. A deadlock (40P01) rolled everything back: the whole transaction runs
// again (3 tries). Every other error propagates unchanged (the step decides: StaleOrderState is a
// silent no-op, GG001 is an alert and never a retry).

const DEADLOCK_TRIES = 3;

/** The evidence changed between the decision and the locked read: nothing was written. */
export class EvidenceChangedError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId}: the chain evidence changed under the resolution, rolled back`);
    this.name = 'EvidenceChangedError';
  }
}

export type ReconcilerResolution =
  | { readonly to: 'DELIVERED'; readonly proof: TonTxProof }
  | { readonly to: 'FAILED'; readonly proof: TonNotSentProof };

export interface ResolvedReview {
  readonly result: ResolveNeedsReviewResult;
  /** The ORDER_REVIEW_RESOLVE row written in the same transaction (the `reviewResolved` ref). */
  readonly auditId: string;
}

@Injectable()
export class ReviewResolver {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  /** `evidence` is `evidenceKey` of the rows the decision was made on. */
  async resolve(
    orderId: string,
    resolution: ReconcilerResolution,
    evidence: string,
  ): Promise<ResolvedReview> {
    for (let tries = 1; ; tries += 1) {
      try {
        return await this.prisma.client.$transaction((tx) =>
          this.resolveIn(tx, orderId, resolution, evidence),
        );
      } catch (error) {
        if (!isDeadlock(error) || tries >= DEADLOCK_TRIES) throw error;
      }
    }
  }

  private async resolveIn(
    tx: Tx,
    orderId: string,
    resolution: ReconcilerResolution,
    evidence: string,
  ): Promise<ResolvedReview> {
    const result = await resolveNeedsReview(tx, {
      orderId,
      to: resolution.to,
      proof: resolution.proof,
      resolver: { kind: 'reconciler' },
    });
    if (evidenceKey(await readReviewPayout(tx, orderId)) !== evidence) {
      throw new EvidenceChangedError(orderId);
    }
    // An order leaves NEEDS_REVIEW once (its exits lead only to REFUNDED): one such row, this one.
    const audit = await tx.auditLog.findFirstOrThrow({
      where: {
        action: ORDER_EFFECTS_ACTIONS.reviewResolve,
        targetType: 'Order',
        targetId: orderId,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    return { result, auditId: audit.id };
  }
}
