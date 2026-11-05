import { alertRef, notifyJobId } from '@repo/shared';
import type { TestUser, WalletE2e } from './wallet-e2e.helpers';

export const OPERATOR = { operator: 'e2e-owner', ip: '203.0.113.9' };

// Small readers the admin e2e files share; they take the suite's harness so each file keeps its
// own app instance.
export function adminProbes(e2e: WalletE2e) {
  return {
    balanceOf: async (user: TestUser): Promise<string> => {
      const res = await e2e.get('/me/wallet', user);
      return (res.body.data as { balanceTiyin: string }).balanceTiyin;
    },
    sumOf: async (userId: string): Promise<bigint> => {
      const agg = await e2e.db().ledgerEntry.aggregate({
        where: { userId },
        _sum: { amountTiyin: true },
      });
      return agg._sum.amountTiyin ?? 0n;
    },
    frozenAlert: async (userId: string, ledgerEntryId: string) => {
      const id = notifyJobId({
        kind: 'OWNER_ALERT',
        alert: 'walletFrozen',
        refId: alertRef.walletFrozen(userId, ledgerEntryId),
      });
      e2e.trackJob(id);
      return e2e.notifyQueue().getJob(id);
    },
  };
}
