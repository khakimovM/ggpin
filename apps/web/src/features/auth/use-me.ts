'use client';

import type { Me } from '@repo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getMe } from '../../lib/api/me';
import { qk } from '../../lib/query-keys';

const ME_STALE_TIME_MS = 60_000;

/**
 * The signed-in user. `required` (default) sends a visitor with a lost session to the login page;
 * `optional` is for public pages that only decorate themselves when somebody is signed in.
 */
export function useMe(
  options: { session?: 'required' | 'optional'; enabled?: boolean } = {},
): UseQueryResult<Me> {
  const { session = 'required', enabled = true } = options;
  return useQuery({
    queryKey: qk.me(),
    queryFn: ({ signal }) => getMe({ session, signal }),
    staleTime: ME_STALE_TIME_MS,
    enabled,
  });
}
