'use client';

import { useQuery } from '@tanstack/react-query';
import { getPaymentMethods } from '../../lib/api/payments';
import { qk } from '../../lib/query-keys';
import { limitsOf } from './topup-limits';

const METHODS_STALE_MS = 60_000;

/** `GET /payments/methods`: availability and the limits. `limits` is null when the method is off. */
export function useTopupMethods(options: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: qk.payments.methods(),
    queryFn: ({ signal }) => getPaymentMethods(signal),
    staleTime: METHODS_STALE_MS,
    enabled: options.enabled ?? true,
  });
  return { query, limits: query.data === undefined ? undefined : limitsOf(query.data) };
}
