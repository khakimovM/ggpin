'use client';

import type { SessionItem } from '@repo/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { listSessions, revokeSession } from '../../lib/api/auth';
import { isApiError } from '../../lib/api/errors';
import { qk } from '../../lib/query-keys';

/** `GET /auth/sessions`: the devices signed in to this account, last used first. */
export function useSessions(): UseQueryResult<SessionItem[]> {
  return useQuery({
    queryKey: qk.sessions(),
    queryFn: ({ signal }) => listSessions(signal),
    staleTime: 0,
  });
}

/** A session that is already gone (404) is what the user asked for: not an error. */
async function endSession(id: string): Promise<void> {
  try {
    await revokeSession(id);
  } catch (error) {
    if (isApiError(error) && error.status === 404) return;
    throw error;
  }
}

/**
 * `DELETE /auth/sessions/:id` for ANOTHER device. The list is refetched either way: a session that
 * was already gone (404) disappears from it too. Ending the current device goes through logout.
 */
export function useRevokeSession(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => endSession(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.sessions() }),
  });
}

/**
 * "Boshqa barcha sessiyalarni yakunlash": the same DELETE for each given id, one after another (not
 * in parallel). The first real failure stops the rest; the list is refetched either way, so it
 * shows what is still open.
 */
export function useRevokeOtherSessions(): UseMutationResult<void, Error, readonly string[]> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: readonly string[]) => {
      for (const id of ids) await endSession(id);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.sessions() }),
  });
}
