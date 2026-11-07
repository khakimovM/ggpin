'use client';

import type { WalletResponse } from '@repo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getWallet } from '../../lib/api/me';
import { qk } from '../../lib/query-keys';

const WALLET_STALE_MS = 30_000;

/**
 * Balance and coins exactly as the server computed them (`GET /me/wallet`; mocked in development
 * through the `wallet` group until the wallet module is on the API). Nothing is added or
 * subtracted here: a purchase or a top-up invalidates `qk.wallet.all` and this refetches.
 */
export function useWallet(options: { enabled?: boolean } = {}): UseQueryResult<WalletResponse> {
  return useQuery({
    queryKey: qk.wallet.balance(),
    queryFn: ({ signal }) => getWallet(signal),
    staleTime: WALLET_STALE_MS,
    enabled: options.enabled ?? true,
  });
}
