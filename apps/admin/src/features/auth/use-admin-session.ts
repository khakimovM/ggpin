import type { AdminMeResponse, AdminPermission } from '@repo/shared';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { getAdminMe, logoutAdmin } from '../../lib/api/auth';
import { isApiError } from '../../lib/api/errors';
import { isPrivateQuery, qk } from '../../lib/query-keys';

/**
 * `GET /admin/auth/me`. `null` = not signed in: the API answers a missing, expired or revoked
 * session with 404 (D-26), which is an answer here, not an error. Any other failure (network,
 * 5xx) stays an error, so the shell can offer a retry instead of throwing the operator out.
 */
export async function fetchSession(signal?: AbortSignal): Promise<AdminMeResponse | null> {
  try {
    return await getAdminMe(signal);
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
}

export function useAdminSession(): UseQueryResult<AdminMeResponse | null> {
  return useQuery({
    queryKey: qk.auth.me(),
    queryFn: ({ signal }) => fetchSession(signal),
    // The session's idle timer is renewed by any admin request; a minute is fresh enough for
    // the role and the permission list.
    staleTime: 60_000,
  });
}

/** Whether the signed-in admin's role carries a permission (UX only: the API decides). */
export function hasPermission(
  session: AdminMeResponse | null | undefined,
  permission: AdminPermission,
): boolean {
  return session?.permissions.includes(permission) ?? false;
}

/** Sign out: the API ends the session and clears the cookie; the cache follows. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logoutAdmin,
    onSettled: () => {
      // Whatever the answer (a dead session answers 404), this browser is signed out now.
      queryClient.removeQueries({ predicate: (query) => isPrivateQuery(query.queryKey) });
      queryClient.setQueryData(qk.auth.me(), null);
    },
  });
}
