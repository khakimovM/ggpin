import { ADMIN_CODELESS_BUDGET_FLAG, codelessBudgetExceeded, tashkentDayStart } from '@repo/shared';
import type { Db } from '../../infra/prisma/db';
import { isAdminActor, type CheckedAuditActor } from './audit-actor';
import { codelessUsageSince, lockCodelessBudget } from './codeless-budget.repository';

// The panel's codeless daily budget (owner decision 2026-11-18, SA-S6-3): a wallet debit at or
// below the threshold, or a reversal at or below it, needs no code until the acting admin's
// codeless actions of the Tashkent day pass 10 or 2 000 000 so'm. The CLI has no such budget.

const magnitude = (tiyin: bigint): bigint => (tiyin < 0n ? -tiyin : tiyin);

/** Only a codeless-sized debit or reversal by an admin is counted at all. */
function counted(actor: CheckedAuditActor, amountTiyin: bigint, thresholdTiyin: bigint): boolean {
  return isAdminActor(actor) && magnitude(amountTiyin) <= thresholdTiyin;
}

/**
 * Inside the transaction, after the wallet lock: whether THIS action passes the budget, read
 * under the admin's budget lock (held to the commit, so the action's own audit row counts for
 * the next one). `undefined` when the budget does not apply (CLI, above the threshold, a code).
 */
export async function codelessBudgetInTx(
  tx: Db,
  actor: CheckedAuditActor,
  check: { readonly amountTiyin: bigint; readonly thresholdTiyin: bigint; readonly now: Date },
): Promise<boolean | undefined> {
  if (!isAdminActor(actor) || !counted(actor, check.amountTiyin, check.thresholdTiyin)) {
    return undefined;
  }
  await lockCodelessBudget(tx, actor.adminId);
  const used = await codelessUsageSince(tx, actor.adminId, tashkentDayStart(check.now));
  return codelessBudgetExceeded(used, check.amountTiyin);
}

/**
 * The binding flag naming the budget as the reason for the code, read without a lock (the
 * confirmation and the action's pre-check read the same way). Usage only grows during a day, so
 * a code issued for this reason still carries it when the action runs, except across Tashkent
 * midnight: the budget starts again, a code issued at 23:59 no longer matches the binding
 * (CODE_INVALID) and the same action sent again without a code passes.
 */
export async function codelessBudgetFlags(
  db: Db,
  adminId: string | null,
  check: { readonly amountTiyin: bigint; readonly thresholdTiyin: bigint; readonly now: Date },
): Promise<string[]> {
  if (adminId === null || magnitude(check.amountTiyin) > check.thresholdTiyin) return [];
  const used = await codelessUsageSince(db, adminId, tashkentDayStart(check.now));
  return codelessBudgetExceeded(used, check.amountTiyin) ? [ADMIN_CODELESS_BUDGET_FLAG] : [];
}

/** The acting admin's id, or null for the CLI (which has no budget). */
export function budgetAdminId(actor: CheckedAuditActor): string | null {
  return isAdminActor(actor) ? actor.adminId : null;
}
