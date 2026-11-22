import type { CodelessUsage } from '@repo/shared';
import type { Db } from '../../infra/prisma/db';

// The admin's codeless money actions of the day (owner decision 2026-11-18, SA-S6-3). Plain
// functions on the caller's transaction, like lockAdminActor.

/**
 * One admin's budget is serialised by a transaction-scoped advisory lock, taken after the wallet
 * lock (lock order: AdminUser -> wallet -> this): two codeless actions of the same admin on
 * different wallets cannot both read the same usage and together pass the budget.
 */
export async function lockCodelessBudget(tx: Db, adminId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-codeless:${adminId}`}, 0))`;
}

/**
 * The admin's codeless wallet debits and top-up reversals since `since`: the panel's audit rows
 * (actorType ADMIN, this admin, `after.otpVerified` not true) joined to the ledger entry each one
 * wrote, so a rolled-back action never counts and the amount is the money actually moved. A debit
 * is the negative ADJUSTMENT whose refId is the audit row; a reversal is the TOPUP_REVERSAL of
 * the payment the audit row targets. The CLI's rows (actorType CLI) never count.
 */
export async function codelessUsageSince(
  tx: Db,
  adminId: string,
  since: Date,
): Promise<CodelessUsage> {
  const rows = await tx.$queryRaw<{ count: number; sumTiyin: bigint }[]>`
    SELECT COUNT(*)::int AS "count", COALESCE(SUM(-l."amountTiyin"), 0)::bigint AS "sumTiyin"
    FROM "AuditLog" a
    JOIN "LedgerEntry" l ON (
      (a."action" = 'WALLET_ADJUST' AND l."kind" = 'ADJUSTMENT'
        AND l."refType" = 'ADMIN_ACTION' AND l."refId" = a."id")
      OR (a."action" = 'PAYMENT_REVERSE' AND l."kind" = 'TOPUP_REVERSAL'
        AND l."refType" = 'PAYMENT' AND l."refId" = a."targetId")
    )
    WHERE a."actorType" = 'ADMIN' AND a."actorId" = ${adminId} AND a."createdAt" >= ${since}
      AND a."action" IN ('WALLET_ADJUST', 'PAYMENT_REVERSE')
      AND l."amountTiyin" < 0
      AND COALESCE(a."after"->>'otpVerified', 'false') <> 'true'`;
  return { count: rows[0]?.count ?? 0, sumTiyin: rows[0]?.sumTiyin ?? 0n };
}
