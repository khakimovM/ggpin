'use client';

import { type LoginStatusResponse } from '@repo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getLoginStatus } from '../../lib/api/auth';
import { isApiError } from '../../lib/api/errors';
import { qk } from '../../lib/query-keys';
import { POLL_INTERVAL_MS, POLL_MAX_MS } from './login-machine';

/** Seconds to back off when a 429 carries no usable `Retry-After`. */
const RATE_LIMIT_BACKOFF_SEC = 10;

/**
 * Milliseconds until the next status poll, or `false` to stop. Pure, so the schedule is tested
 * without timers: every 2 s while PENDING, never past the 10 minutes the nonce lives, and after a
 * 429 not before the server's `Retry-After` (polling through a rate limit only prolongs it).
 */
export function nextPollDelayMs(
  status: LoginStatusResponse['status'] | undefined,
  error: unknown,
  elapsedMs: number,
): number | false {
  if (status !== undefined && status !== 'PENDING') return false;
  if (elapsedMs >= POLL_MAX_MS) return false;
  if (isApiError(error) && error.code === 'RATE_LIMITED') {
    return Math.max(POLL_INTERVAL_MS, (error.retryAfterSec ?? RATE_LIMIT_BACKOFF_SEC) * 1000);
  }
  return POLL_INTERVAL_MS;
}

/**
 * `GET /auth/telegram/status/:nonce` every 2 s while the user opens the bot. Polling stops on the
 * first answer other than PENDING (CODE_SENT, DENIED, EXPIRED), 10 minutes after it started
 * (the nonce is dead by then), and when `nonce` is null (the screen left the waiting step).
 */
export function useLoginStatus(
  nonce: string | null,
  attempt: number,
  startedAt: number,
): UseQueryResult<LoginStatusResponse> {
  return useQuery({
    queryKey: qk.auth.loginStatus(attempt),
    queryFn: ({ signal }) =>
      nonce === null ? Promise.reject(new Error('no nonce')) : getLoginStatus(nonce, signal),
    enabled: nonce !== null,
    staleTime: 0,
    gcTime: 0,
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      nextPollDelayMs(query.state.data?.status, query.state.error, Date.now() - startedAt),
  });
}
