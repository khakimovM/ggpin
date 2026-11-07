'use client';

import { type Me } from '@repo/shared';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { z } from 'zod';
import { env } from '../../env';
import { errorDetails, isApiError } from '../../lib/api/errors';
import { INITIAL_PHASE, POLL_MAX_MS, loginReducer, type LoginPhase } from './login-machine';
import { botUrlIsOurs, problemOf } from './login-problem';
import { useLoginStart } from './use-login-start';
import { useLoginStatus } from './use-login-status';
import { useLoginVerify } from './use-login-verify';

// `details` of 422 CODE_INVALID (docs/04): how many of the 5 tries are left.
const codeInvalidDetails = z.object({ attemptsLeft: z.number().int().min(0) });

export interface LoginFlow {
  phase: LoginPhase;
  /** Start (or restart) the login: asks the API for a nonce. */
  start: () => void;
  /** Back to the first step without any request. */
  reset: () => void;
  submit: (code: string) => void;
  /** The code boxes were edited: clears the "wrong code" / failure notice. */
  codeEdited: () => void;
  codeExpired: () => void;
}

const displayNameOf = (user: Me): string | null => user.firstName ?? user.username;

/** The whole web login behaviour; the components only render `phase` and call these. */
export function useLoginFlow(): LoginFlow {
  const [phase, dispatch] = useReducer(loginReducer, INITIAL_PHASE);
  const [attempt, setAttempt] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const startMutation = useLoginStart();
  const verifyMutation = useLoginVerify();
  const { mutate: requestStart } = startMutation;
  const { mutate: requestVerify } = verifyMutation;

  const nonce = phase.name === 'waiting' ? phase.nonce : null;
  const status = useLoginStatus(nonce, attempt, startedAt);

  // The bot answered (or refused, or the nonce is gone).
  const polled = status.data?.status;
  useEffect(() => {
    if (polled !== undefined) dispatch({ type: 'STATUS', status: polled, now: Date.now() });
  }, [polled]);
  const polledError = status.error;
  useEffect(() => {
    // The API answers an unknown nonce with 404: for the user that is an expired request.
    if (isApiError(polledError) && polledError.status === 404) {
      dispatch({ type: 'STATUS', status: 'EXPIRED', now: Date.now() });
    }
  }, [polledError]);

  // The nonce lives 10 minutes; past that, stop waiting even if every poll said PENDING.
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
        dispatch(
          botUrlIsOurs(result.botUrl, env.NEXT_PUBLIC_BOT_USERNAME)
            ? { type: 'STARTED', nonce: result.nonce, botUrl: result.botUrl }
            : { type: 'START_FAILED', problem: { kind: 'generic' } },
        ),
      onError: (error) => dispatch({ type: 'START_FAILED', problem: problemOf(error) }),
    });
  }, [phase.name, verifying, requestStart]);

  const submit = useCallback(
    (code: string) => {
      if (phase.name !== 'code' || phase.verifying) return;
      // Retry-After is the server's wait: editing the boxes or pressing the button early is no way
      // around it.
      if (phase.problem?.kind === 'rateLimited' && Date.now() < phase.problem.until) return;
      dispatch({ type: 'VERIFY_START' });
      requestVerify(
        { nonce: phase.nonce, code },
        {
          onSuccess: ({ user }) =>
            dispatch({ type: 'VERIFY_OK', displayName: displayNameOf(user) }),
          onError: (error) => dispatch(verifyFailure(error)),
        },
      );
    },
    [phase, requestVerify],
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

function verifyFailure(error: unknown) {
  if (isApiError(error)) {
    if (error.code === 'CODE_INVALID') {
      const details = errorDetails(error, codeInvalidDetails);
      if (details !== undefined) {
        return { type: 'VERIFY_WRONG', attemptsLeft: details.attemptsLeft } as const;
      }
    }
    if (error.code === 'CODE_EXPIRED' || error.code === 'CODE_ALREADY_USED') {
      return { type: 'VERIFY_EXPIRED' } as const;
    }
  }
  return { type: 'VERIFY_FAILED', problem: problemOf(error) } as const;
}
