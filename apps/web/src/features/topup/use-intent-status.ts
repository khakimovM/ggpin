'use client';

import type { IntentStatus, TopupIntent } from '@repo/shared';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isApiError } from '../../lib/api/errors';
import { getTopupIntent, listTopupIntents } from '../../lib/api/payments';
import { qk } from '../../lib/query-keys';

/** docs/04: at least 5 seconds between two polls of a waiting request. */
export const INTENT_POLL_MS = 5000;
/**
 * An EXPIRED request can still turn PAID for 24 hours (a late transfer, docs/04), so it is asked
 * about slowly while its screen is open instead of being declared final.
 */
export const EXPIRED_POLL_MS = 30_000;

export function intentPollInterval(
  status: IntentStatus | undefined,
  error: unknown,
): number | false {
  if (isApiError(error) && error.status === 404) return false;
  if (status === undefined || status === 'PENDING') return INTENT_POLL_MS;
  return status === 'EXPIRED' ? EXPIRED_POLL_MS : false;
}

/**
 * One top-up request of the signed-in user (`GET /payments/intents/:id`, the session, not a pay
 * token). Polled while it waits; asked again at once when the visitor comes back from the browser
 * (`visibilitychange`), together with the wallet. A PAID or EXPIRED answer also refreshes the
 * wallet: a late transfer may have credited it.
 */
export function useTopupIntent(id: string): UseQueryResult<TopupIntent> {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: qk.payments.intent(id),
    queryFn: ({ signal }) => getTopupIntent(id, signal),
    staleTime: 0,
    refetchInterval: (q) => intentPollInterval(q.state.data?.status, q.state.error),
  });

  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState !== 'visible') return;
      void queryClient.invalidateQueries({ queryKey: qk.payments.intent(id) });
      void queryClient.invalidateQueries({ queryKey: qk.wallet.all });
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [queryClient, id]);

  const status = query.data?.status;
  useEffect(() => {
    // A request that has ended is no longer the waiting one: the pill and the "unfinished payment"
    // sheet read the list again; a PAID or EXPIRED one may also have credited the wallet.
    if (status === 'PAID' || status === 'EXPIRED' || status === 'CANCELLED') {
      void queryClient.invalidateQueries({ queryKey: qk.payments.intents(PENDING_FILTER) });
      void queryClient.invalidateQueries({ queryKey: qk.wallet.all });
    }
  }, [status, queryClient]);

  return query;
}

export const PENDING_FILTER = { status: 'PENDING', limit: 1 } as const;

/**
 * The user's waiting request, if any (`GET /payments/intents?status=PENDING&limit=1`): behind the
 * "you have an unfinished payment" sheet and the pill on the home screen. A request whose
 * `expiresAt` has passed is not waiting any more, whatever a stale answer says.
 */
export function usePendingIntent(): UseQueryResult<TopupIntent | null> {
  return useQuery({
    queryKey: qk.payments.intents(PENDING_FILTER),
    queryFn: async ({ signal }) => (await listTopupIntents(PENDING_FILTER, signal))[0] ?? null,
    staleTime: 15_000,
  });
}
