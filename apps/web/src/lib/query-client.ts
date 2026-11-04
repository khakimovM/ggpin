import { isServer, QueryClient } from '@tanstack/react-query';

// The API error type arrives with the API client (S2); until then any thrown value that carries a
// numeric HTTP `status` is treated as an HTTP error.
function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

// A 4xx answer will not change on a second try (validation, auth, not found, insufficient
// balance), so it is surfaced at once. 5xx and network errors get one more attempt.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < 1;
}

// 30 s suits catalog-like data. Money views (wallet, orders, payment intents) must not rely on
// it: they set staleTime explicitly and refetch after every mutation that moves money.
export const DEFAULT_STALE_TIME_MS = 30_000;

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
    },
  });
}

let browserClient: QueryClient | undefined;

// On the server every request gets its own client (no data shared between users);
// in the browser one client lives for the whole session.
export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserClient ??= makeQueryClient();
  return browserClient;
}
