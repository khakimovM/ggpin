'use client';

import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { isApiError, NETWORK_CODE } from '../../lib/api/errors';
import { validateRecipient } from '../../lib/api/recipients';
import {
  INITIAL_RECIPIENT,
  isValidUsername,
  normalizeUsername,
  recipientReducer,
  type RecipientState,
} from './recipient-machine';

export interface RecipientControls {
  state: RecipientState;
  /** The token of a CONFIRMED recipient, else null: the only thing a quote may be asked with. */
  confirmedToken: string | null;
  setUsername: (raw: string) => void;
  check: () => void;
  confirm: () => void;
  reset: () => void;
  /** The server refused the token (a quote answered RECIPIENT_INVALID): ask for it again. */
  expire: () => void;
}

/**
 * `POST /recipients/validate` behind the recipient state machine. `inputKey` is the product's
 * `inputSchema` field key (`username` for a Telegram product). A badly formed username never
 * leaves the browser (the server would say 400 anyway), and a check that is overtaken by an edit
 * is aborted and its answer ignored, so a late answer cannot confirm the wrong person.
 * `onProductChanged` runs when the server says the product itself is no longer sellable
 * (PRODUCT_UNAVAILABLE): the page reloads the product to show what is true now.
 */
export function useValidateRecipient(
  productId: string,
  inputKey: string,
  onProductChanged: () => void,
): RecipientControls {
  const [state, dispatch] = useReducer(recipientReducer, INITIAL_RECIPIENT);
  const inFlight = useRef<AbortController | null>(null);
  const mutation = useMutation({
    mutationFn: ({ username, signal }: { username: string; signal: AbortSignal }) =>
      validateRecipient({ productId, input: { [inputKey]: username } }, signal),
  });
  const { mutate } = mutation;

  const abort = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);
  useEffect(() => abort, [abort]);

  const setUsername = useCallback(
    (raw: string) => {
      // The same text again (after the "@" and spaces are dropped) is not an edit: a check on its
      // way stays.
      if (normalizeUsername(raw) === state.username) return;
      abort();
      dispatch({ type: 'edit', username: raw });
    },
    [abort, state.username],
  );

  const check = useCallback(() => {
    if (state.phase === 'checking') return;
    if (state.retryAt !== null && Date.now() < state.retryAt) return;
    if (!isValidUsername(state.username)) {
      dispatch({ type: 'invalid' });
      return;
    }
    abort();
    const controller = new AbortController();
    inFlight.current = controller;
    dispatch({ type: 'checking' });
    mutate(
      { username: state.username, signal: controller.signal },
      {
        onSuccess: (response) => {
          if (!controller.signal.aborted) dispatch({ type: 'found', response });
        },
        onError: (error) => {
          if (controller.signal.aborted) return;
          const code = isApiError(error) ? error.code : NETWORK_CODE;
          if (code === 'PRODUCT_UNAVAILABLE') onProductChanged();
          dispatch({
            type: 'failed',
            code,
            at: Date.now(),
            retryAfterSec: isApiError(error) ? error.retryAfterSec : undefined,
          });
        },
      },
    );
  }, [abort, mutate, onProductChanged, state.phase, state.retryAt, state.username]);

  const confirm = useCallback(() => dispatch({ type: 'confirm' }), []);
  const expire = useCallback(() => dispatch({ type: 'expire' }), []);
  const reset = useCallback(() => {
    abort();
    dispatch({ type: 'reset' });
  }, [abort]);

  return {
    state,
    confirmedToken: state.phase === 'confirmed' ? state.token : null,
    setUsername,
    check,
    confirm,
    reset,
    expire,
  };
}
