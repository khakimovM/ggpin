import { isServer, QueryClient } from '@tanstack/react-query';

// ApiError carries the HTTP status (0 = no response). Any other thrown value with a numeric
// `status` is treated the same way; one without it is a network-level failure.
function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

export const MAX_QUERY_RETRIES = 2;

// Only failures that can pass on their own are retried: no answer at all (offline, reset
// connection) and 5xx. A 4xx will not change on a second try (validation, auth, not found,
// insufficient balance), and a 2xx that failed schema validation is a contract break, not a
// glitch; both surface at once.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  const status = statusOf(error);
  return status === undefined || status === 0 || status >= 500;
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
      // A repeated mutation could move money twice. Retrying is the user's decision, and it
      // reuses the same Idempotency-Key.
      mutations: { retry: false },
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
