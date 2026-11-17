import type { AdminLoginStatusResponse } from '@repo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { getAdminLoginStatus, startAdminLogin, verifyAdminLogin } from '../../lib/api/auth';
import { attemptsLeftOf, isApiError } from '../../lib/api/errors';
import { qk } from '../../lib/query-keys';
import {
  INITIAL_PHASE,
  POLL_INTERVAL_MS,
  POLL_MAX_MS,
  loginReducer,
  problemOf,
  type LoginEvent,
  type LoginPhase,
} from './login-machine';

/** Seconds to back off when a 429 on the status poll carries no usable `Retry-After`. */
const RATE_LIMIT_BACKOFF_SEC = 10;

/** Milliseconds until the next status poll, or `false` to stop (pure, tested without timers). */
export function nextPollDelayMs(
  status: AdminLoginStatusResponse['status'] | undefined,
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

export function verifyFailure(error: unknown, now: number): LoginEvent {
  const attemptsLeft = attemptsLeftOf(error);
  if (attemptsLeft !== undefined) return { type: 'VERIFY_WRONG', attemptsLeft };
  if (isApiError(error) && error.code === 'CODE_EXPIRED') return { type: 'VERIFY_EXPIRED' };
  return { type: 'VERIFY_FAILED', problem: problemOf(error, now) };
}

export interface LoginFlow {
  phase: LoginPhase;
  start: () => void;
  reset: () => void;
  submit: (code: string) => void;
  codeEdited: () => void;
  codeExpired: () => void;
}

/** The whole admin login behaviour; the components only render `phase` and call these. */
export function useLoginFlow(): LoginFlow {
  const queryClient = useQueryClient();
  const [phase, dispatch] = useReducer(loginReducer, INITIAL_PHASE);
  const [attempt, setAttempt] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const { mutate: requestStart } = useMutation({ mutationFn: startAdminLogin });
  const { mutate: requestVerify } = useMutation({
    mutationFn: ({ nonce, code }: { nonce: string; code: string }) => verifyAdminLogin(nonce, code),
  });

  const nonce = phase.name === 'waiting' ? phase.nonce : null;
  const status = useQuery({
    queryKey: qk.auth.loginStatus(attempt),
    queryFn: ({ signal }) =>
      nonce === null ? Promise.reject(new Error('no nonce')) : getAdminLoginStatus(nonce, signal),
    enabled: nonce !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      nextPollDelayMs(query.state.data?.status, query.state.error, Date.now() - startedAt),
  });

  const polled = status.data?.status;
  useEffect(() => {
    if (polled !== undefined) dispatch({ type: 'STATUS', status: polled, now: Date.now() });
  }, [polled]);
  const polledError = status.error;
  useEffect(() => {
    // An unknown or malformed nonce is a 404: for the operator that is an expired request.
    if (isApiError(polledError) && polledError.status === 404) {
      dispatch({ type: 'STATUS', status: 'EXPIRED', now: Date.now() });
    }
  }, [polledError]);

  useEffect(() => {
    if (nonce === null) return undefined;
    const left = Math.max(0, POLL_MAX_MS - (Date.now() - startedAt));
    const timer = setTimeout(() => dispatch({ type: 'POLL_TIMEOUT' }), left);
    return () => clearTimeout(timer);
  }, [nonce, startedAt]);

  const verifying = phase.name === 'code' && phase.verifying;
  const start = useCallback(() => {
    const restartable =
      phase.name === 'start' ||
      phase.name === 'expired' ||
      phase.name === 'rejected' ||
      (phase.name === 'code' && !verifying);
    if (!restartable) return;
    dispatch({ type: 'START' });
    setStartedAt(Date.now());
    setAttempt((value) => value + 1);
    requestStart(undefined, {
      onSuccess: (result) =>
        dispatch({ type: 'STARTED', nonce: result.nonce, botUrl: result.botUrl }),
      onError: (error) => dispatch({ type: 'START_FAILED', problem: problemOf(error, Date.now()) }),
    });
  }, [phase.name, verifying, requestStart]);

  const submit = useCallback(
    (code: string) => {
      if (phase.name !== 'code' || phase.verifying) return;
      if (phase.problem?.kind === 'rateLimited' && Date.now() < phase.problem.until) return;
      dispatch({ type: 'VERIFY_START' });
      requestVerify(
        { nonce: phase.nonce, code },
        {
          onSuccess: () => {
            dispatch({ type: 'VERIFY_OK' });
            // The cookie is set: the session query decides where the operator lands.
            void queryClient.invalidateQueries({ queryKey: qk.auth.me() });
          },
          onError: (error) => dispatch(verifyFailure(error, Date.now())),
        },
      );
    },
    [phase, requestVerify, queryClient],
  );

  return {
    phase,
    start,
    submit,
    reset: useCallback(() => dispatch({ type: 'RESET' }), []),
    codeEdited: useCallback(() => dispatch({ type: 'CODE_EDITED' }), []),
    codeExpired: useCallback(() => dispatch({ type: 'TTL_ELAPSED' }), []),
  };
}
