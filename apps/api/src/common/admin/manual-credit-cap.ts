import { tashkentDayStart } from '@repo/shared';
import type { Db } from '../../infra/prisma/db';
import { validationError } from './admin-input';

/** The repository side of the cap (WalletRepository, ReviewRepository). */
export interface ManualCreditLedger {
  lockManualCredits(tx: Db): Promise<void>;
  manualCreditTotalSince(tx: Db, since: Date): Promise<bigint>;
}

export const MANUAL_CREDIT_CAP_REASON = 'MANUAL_CREDIT_DAILY_CAP';

/** At the cap itself the credit passes; one tiyin over it does not. */
export function withinManualCreditCap(usedTiyin: bigint, amountTiyin: bigint, capTiyin: bigint) {
  return usedTiyin + amountTiyin <= capTiyin;
}

/**
 * The daily cap of money created by hand (D-63 (5), D-46 deferred): positive adjustments and
 * review credits of the current Asia/Tashkent day, CLI and panel together, checked under the
 * caller's wallet lock and the cap lock. Over it: refused, nothing written; only raising
 * ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN lets more through.
 */
export async function checkManualCreditCap(
  ledger: ManualCreditLedger,
  tx: Db,
  credit: { readonly amountTiyin: bigint; readonly capTiyin: bigint; readonly now: Date },
): Promise<void> {
  if (credit.amountTiyin <= 0n) return;
  await ledger.lockManualCredits(tx);
  const used = await ledger.manualCreditTotalSince(tx, tashkentDayStart(credit.now));
  if (!withinManualCreditCap(used, credit.amountTiyin, credit.capTiyin)) {
    throw validationError('amountTiyin', MANUAL_CREDIT_CAP_REASON);
  }
}
