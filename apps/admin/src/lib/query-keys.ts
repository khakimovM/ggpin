// The one registry of TanStack Query keys of the admin panel. Every feature reads its keys from
// here, so an invalidation after an action can name exactly what it refreshes.
export const qk = {
  auth: {
    all: () => ['auth'] as const,
    me: () => ['auth', 'me'] as const,
    loginStatus: (attempt: number) => ['auth', 'login-status', attempt] as const,
  },
} as const;

/** Everything except the session itself: what a sign-out must drop from the cache. */
export function isPrivateQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] !== 'auth';
}
