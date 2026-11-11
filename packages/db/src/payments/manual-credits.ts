import type { Tx } from '../ledger/ledger.js';

export interface CreditSum {
  readonly count: number;
  readonly sumTiyin: bigint;
}

/** Money the owner gave one user by hand, by the way it was given (D-47 R1). */
export interface ManualCredits {
  /** Positive ADJUSTMENT entries (wallet:adjust, ADMIN_ACTION/<AuditLog.id>). */
  readonly adjust: CreditSum;
  /** TOPUP entries of payments credited from a review (review:credit, Payment.reviewId set). */
  readonly reviewCredit: CreditSum;
}

/**
 * Money the owner gave the user by hand since `since`: the ONE predicate of the worker (the
 * matcher's last gate before an automatic TOPUP, D-47 R1) and the API (the review:credit
 * preview), so the two can never disagree. A review:credit TOPUP is `TOPUP, PAYMENT/<Payment.id>`
 * whose Payment has a `reviewId`; the matcher's own payments have none, so automatic credits and
 * negative adjustments never count. Every NEW way of giving money by hand must be added here
 * (docs/05 §7). Decides a write only when read under the user's Wallet lock.
 */
export async function manualCreditsSince(
  db: Tx,
  userId: string,
  since: Date,
): Promise<ManualCredits> {
  const adjust = await db.ledgerEntry.aggregate({
    where: { userId, kind: 'ADJUSTMENT', amountTiyin: { gt: 0n }, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { amountTiyin: true },
  });
  const topups = { userId, kind: 'TOPUP', refType: 'PAYMENT', createdAt: { gte: since } } as const;
  const refs = await db.ledgerEntry.findMany({ where: topups, select: { refId: true } });
  const reviewed =
    refs.length === 0
      ? []
      : await db.payment.findMany({
          where: { id: { in: refs.map((entry) => entry.refId) }, reviewId: { not: null } },
          select: { id: true },
        });
  const reviewCredit =
    reviewed.length === 0
      ? null
      : await db.ledgerEntry.aggregate({
          where: { ...topups, refId: { in: reviewed.map((payment) => payment.id) } },
          _count: { _all: true },
          _sum: { amountTiyin: true },
        });
  return {
    adjust: { count: adjust._count._all, sumTiyin: adjust._sum.amountTiyin ?? 0n },
    reviewCredit: {
      count: reviewCredit?._count._all ?? 0,
      sumTiyin: reviewCredit?._sum.amountTiyin ?? 0n,
    },
  };
}

/** True when any money was given by hand (the matcher then opens a MANUAL_CREDIT_SEEN review). */
export function hasManualCredit(credits: ManualCredits): boolean {
  return credits.adjust.count > 0 || credits.reviewCredit.count > 0;
}
