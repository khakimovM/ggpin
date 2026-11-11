import type { Query, QueryClient } from '@tanstack/react-query';
import type { SessionLostHandler } from './auth-strategy';
import { loginRedirectTarget } from './login-redirect';

// First segment of the keys that hold PUBLIC data (see query-keys.ts). The list is the exception,
// not the rule: every other root is treated as one user's private data, so a root added to the
// registry later is wiped by default instead of leaking into the next session.
export const PUBLIC_QUERY_ROOTS: ReadonlySet<unknown> = new Set(['catalog']);

export const isPrivateRoot = (root: unknown): boolean => !PUBLIC_QUERY_ROOTS.has(root);

const isPrivate = (query: Query): boolean => isPrivateRoot(query.queryKey[0]);

/**
 * Drops private cached data. Inactive queries are removed; active ones are reset, so their
 * screens fall back to loading instead of showing the previous user's numbers. `clear()` is
 * deliberately not used on the query cache: it silently cancels queries that are still fetching
 * (a parallel catalog request, say) and leaves them pending forever.
 *
 * The mutation cache goes too: it keeps the last result of every mutation, and the result of a
 * top-up request is a card number, an amount and a pay link with its token.
 * Limit: the observers of mounted `useMutation` hooks keep their own copy of the last result, and
 * clearing the cache does not reach it. Those components are closed by a hard navigation after a
 * sign-out or a lost session (phase 7 S3/S4), not by this function.
 */
export function clearPrivateQueries(client: QueryClient): void {
  client.removeQueries({ predicate: isPrivate, type: 'inactive' });
  void client.resetQueries({ predicate: isPrivate, type: 'active' });
  client.getMutationCache().clear();
}

/**
 * Runs the cleanup after the current call stack, so the error that reports the lost session has
 * already reached the query that triggered it (resetting that query in the middle of its own
 * failure would restart it).
 */
export function scheduleClearPrivateQueries(getClient: () => QueryClient): void {
  setTimeout(() => clearPrivateQueries(getClient()), 0);
}

export interface SessionLostDeps {
  getClient: () => QueryClient;
  getLocation: () => { pathname: string; search: string } | undefined;
  navigate: (url: string) => void;
}

export function createSessionLostHandler(deps: SessionLostDeps): SessionLostHandler {
  let leaving = false;
  return (redirect, firstLoss) => {
    if (firstLoss) scheduleClearPrivateQueries(deps.getClient);
    if (!redirect || leaving) return;
    const location = deps.getLocation();
    if (location === undefined) return;
    const target = loginRedirectTarget(location.pathname, location.search);
    if (target === null) return;
    // Several parallel requests can lose the session together; one navigation is enough.
    leaving = true;
    deps.navigate(target);
  };
}
