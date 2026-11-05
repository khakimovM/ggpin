import type { WalletResponse } from '@repo/shared';

// Cashback coins arrive with phase 10; until then the contract says the count is always "0".
const COINS_UNTIL_PHASE_10 = '0';

export function toWalletResponse(balanceTiyin: bigint): WalletResponse {
  return {
    balanceTiyin: balanceTiyin.toString(),
    coins: COINS_UNTIL_PHASE_10,
    currency: 'UZS',
  };
}
