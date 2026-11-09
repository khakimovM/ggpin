'use client';

import type { IntentStatus } from '@repo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '../../lib/api/errors';
import { getPayView } from '../../lib/api/payments';
import { qk } from '../../lib/query-keys';

/** docs/04: the pay page asks again at least every 5 seconds until the request ends. */
export const PAY_POLL_MS = 5000;

const isMissing = (error: unknown): boolean => isApiError(error) && error.status === 404;

/**
 * `refetchInterval` of the pay view: every 5 s while the request waits for money, also after a
 * failed poll (a flaky network heals by itself); never once it has ended, and never after a 404
 * (the token is gone: expired, cancelled or replaced, and asking again changes nothing).
 */
export function payPollInterval(status: IntentStatus | undefined, error: unknown): number | false {
  if (isMissing(error)) return false;
  return status === undefined || status === 'PENDING' ? PAY_POLL_MS : false;
}

/**
 * `GET /payments/pay/:intentId` with the capability token (no cookie, `X-Pay-Token`). The token is
 * NOT part of the query key. No retries: the 5 s poll is the retry, and the page shows a "not
 * updated" bar meanwhile. `answeredToken` is the token the newest answer or error was given
 * for: an "unknown token" for an OLD token must never erase a newer one.
 */
export function usePayView(intentId: string, token: string | null | undefined) {
  const queryClient = useQueryClient();
  const [answeredToken, setAnsweredToken] = useState<string | null>(null);
  const query = useQuery({
    queryKey: qk.payments.display(intentId),
    queryFn: async ({ signal }) => {
      const sent = token ?? '';
      try {
        return await getPayView(intentId, sent, signal);
      } finally {
        // Which token the newest answer (or error) belongs to; a cancelled fetch answers nothing.
        if (!signal.aborted) setAnsweredToken(sent);
      }
    },
    enabled: typeof token === 'string',
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => payPollInterval(query.state.data?.status, query.state.error),
  });

  // A new token for the same request (the link was replaced). An answer to the OLD token may still
  // be on its way, or already stored: it would read "unknown token" (404) and the page would erase
  // the NEW token because of it. The old fetch is cancelled and its state dropped; the new token
  // asks afresh.
  const last = useRef(token);
  useEffect(() => {
    const before = last.current;
    last.current = token;
    if (typeof before === 'string' && typeof token === 'string' && before !== token) {
      void queryClient.resetQueries({ queryKey: qk.payments.display(intentId) });
    }
  }, [queryClient, intentId, token]);

  return { query, answeredToken };
}
