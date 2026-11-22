import type { Db } from '../../infra/prisma/db';

// The money created by hand, for the daily cap shared by the owner CLI and the panel (D-63 (5)).
// Plain functions on the caller's transaction; WalletRepository and ReviewRepository expose them.

/**
 * One cap for every manual credit of every user: serialised by a transaction-scoped advisory
 * lock, taken AFTER the user's wallet lock (every caller holds that one first), so two credits for
 * different users cannot both read the same total and together pass the cap.
 */
export async function lockManualCredits(tx: Db): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('manual-credit-cap', 0))`;
}

/**
 * Money given by hand since `since`, all users: positive ADJUSTMENT entries (wallet:adjust, the
 * panel's adjust-wallet) and TOPUP entries of review payments (review:credit, the panel's credit).
 * The same two kinds as @repo/db `manualCreditsSince` (docs/05 §6, D-47 R1); the ledger rows look
 * the same whoever wrote them, so CLI and panel count together.
 */
export async function manualCreditTotalSince(tx: Db, since: Date): Promise<bigint> {
  const rows = await tx.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(l."amountTiyin"), 0)::bigint AS "total"
    FROM "LedgerEntry" l
    WHERE l."createdAt" >= ${since}
      AND (
        (l."kind" = 'ADJUSTMENT' AND l."amountTiyin" > 0)
        OR (
          l."kind" = 'TOPUP' AND l."refType" = 'PAYMENT'
          AND EXISTS (
            SELECT 1 FROM "Payment" p WHERE p."id" = l."refId" AND p."reviewId" IS NOT NULL
          )
        )
      )`;
  return rows[0]?.total ?? 0n;
}
