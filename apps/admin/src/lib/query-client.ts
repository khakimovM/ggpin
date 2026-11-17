import { QueryClient } from '@tanstack/react-query';

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

export const MAX_QUERY_RETRIES = 2;

// Only failures that can pass on their own are retried: no answer at all and 5xx. A 404 is the
// admin API's answer to every refusal (D-26) and never changes on a second try.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  const status = statusOf(error);
  return status === undefined || status === 0 || status >= 500;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: false },
      // A repeated admin action could move money twice: retrying is the operator's decision, and
      // it reuses the same Idempotency-Key.
      mutations: { retry: false },
    },
  });
}
