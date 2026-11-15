'use client';

import type { ValidateRecipientResponse } from '@repo/shared';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { isApiError, NETWORK_CODE } from '../../lib/api/errors';
import { validateRecipient } from '../../lib/api/recipients';
import { anySignal } from '../../lib/api/transport';
import {
  canonicalUsername,
  INITIAL_RECIPIENT,
  recipientReducer,
  sameRecipient,
  type RecipientState,
} from './recipient-machine';

export interface RecipientControls {
  state: RecipientState;
  /**
   * The canonical username (`aziz_k`), the one form the cards, the summary and checkout show and
   * the server checks; null while what is typed is not a username.
   */
  canonical: string | null;
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
 * How long the browser waits for one `/recipients/validate` answer before it gives up (NETWORK ->
 * `down`, retry by hand). The server answers within its ~10 s wait for the worker
 * (RECIPIENT_CHECK_TIMEOUT_MS) and frees the user's slot by then; the rest is room for a 401 ->
 * refresh -> resend and a slow mobile link. Without it a request hanging on the network would hold
 * the next check in the queue below forever, the form stuck in `checking`. By the time it fires
 * the server's slot (wait + 1 s) is long free, so the next check does not meet a 429.
 */
export const RECIPIENT_REQUEST_TIMEOUT_MS = 25_000;

/** The one `/recipients/validate` request on its way, if any. */
interface InFlight {
  controller: AbortController;
  /**
   * Fulfils when the HTTP request is over, whatever its outcome (answer, error, timeout, abort);
   * it never rejects, so a check waiting on it always gets its turn.
   */
  settled: Promise<void>;
}

/**
 * `POST /recipients/validate` behind the recipient state machine. `inputKey` is the product's
 * `inputSchema` field key (`username` for a Telegram product). A badly formed username never
 * leaves the browser (the server would say 400 anyway). `onProductChanged` runs when the server
 * says the product itself is no longer sellable (PRODUCT_UNAVAILABLE): the page reloads it.
 *
 * At most ONE request is on its way at a time. The server holds a per-user slot for a check until
 * its handler is done (the worker answered or its ~10 s wait ran out; RecipientCheckGate), and a
 * closed connection does not end the handler early: aborting a fetch frees nothing there, and a
 * new request sent at once would only meet a 429. So an edit does not abort the request; it
 * moves the generation on, which makes the answer ignored (a late answer can never confirm the
 * wrong person), and the next check waits, shown as `checking`, until the previous request is
 * over. Only unmounting aborts, since nothing is left to show the answer to.
 */
export function useValidateRecipient(
  productId: string,
  inputKey: string,
  onProductChanged: () => void,
): RecipientControls {
  const [state, dispatch] = useReducer(recipientReducer, INITIAL_RECIPIENT);
  const inFlight = useRef<InFlight | null>(null);
  // Bumped by every edit, check and unmount: only the newest check may dispatch its answer.
  const generation = useRef(0);
  const { mutateAsync } = useMutation({
    mutationFn: ({ username, signal }: { username: string; signal: AbortSignal }) =>
      validateRecipient({ productId, input: { [inputKey]: username } }, signal),
  });

  useEffect(
    () => () => {
      generation.current += 1;
      inFlight.current?.controller.abort();
      inFlight.current = null;
    },
    [],
  );

  const send = useCallback(
    (username: string, ticket: number) => {
      const controller = new AbortController();
      // A timer of our own (not timeoutSignal): it is cleared when the request ends, so no timer
      // outlives it. Its abort reason is a TimeoutError, which the HTTP client reports as NETWORK.
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new DOMException('recipient check timed out', 'TimeoutError')),
        RECIPIENT_REQUEST_TIMEOUT_MS,
      );
      const current = () => ticket === generation.current;
      const onAnswer = (response: ValidateRecipientResponse) => {
        if (current() && !controller.signal.aborted)
          dispatch({ type: 'found', username, response });
      };
      const onFailure = (error: unknown) => {
        if (!current() || controller.signal.aborted) return;
        const code = isApiError(error) ? error.code : NETWORK_CODE;
        dispatch({
          type: 'failed',
          username,
          code,
          at: Date.now(),
          retryAfterSec: isApiError(error) ? error.retryAfterSec : undefined,
        });
        // After the dispatch: a throwing callback cannot leave the form stuck in `checking`.
        if (code === 'PRODUCT_UNAVAILABLE') onProductChanged();
      };
      const entry: InFlight = {
        controller,
        settled: mutateAsync({ username, signal: anySignal([controller.signal, timeout.signal]) })
          .then(onAnswer, onFailure)
          // Even a throwing handler must not leave a rejected promise for the next check to wait on.
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(timer);
            if (inFlight.current === entry) inFlight.current = null;
          }),
      };
      inFlight.current = entry;
    },
    [mutateAsync, onProductChanged],
  );

  const setUsername = useCallback(
    (raw: string) => {
      // Another spelling of the same person (`Aziz_K` -> `aziz_k`) is not an edit: a check on its
      // way and a confirmation stay.
      if (!sameRecipient(raw, state.username)) generation.current += 1;
      dispatch({ type: 'edit', username: raw });
    },
    [state.username],
  );

  const check = useCallback(() => {
    if (state.phase === 'checking') return;
    if (state.retryAt !== null && Date.now() < state.retryAt) return;
    const username = canonicalUsername(state.username);
    if (username === null) {
      dispatch({ type: 'invalid' });
      return;
    }
    generation.current += 1;
    const ticket = generation.current;
    dispatch({ type: 'checking' });
    const previous = inFlight.current;
    if (previous === null) {
      send(username, ticket);
      return;
    }
    // The previous request (its answer already ignored) still holds the server's slot: wait.
    void previous.settled.then(() => {
      if (ticket === generation.current) send(username, ticket);
    });
  }, [send, state.phase, state.retryAt, state.username]);

  const confirm = useCallback(() => dispatch({ type: 'confirm' }), []);
  const expire = useCallback(() => dispatch({ type: 'expire' }), []);
  const reset = useCallback(() => {
    generation.current += 1;
    dispatch({ type: 'reset' });
  }, []);

  return {
    state,
    canonical: canonicalUsername(state.username),
    confirmedToken: state.phase === 'confirmed' ? state.token : null,
    setUsername,
    check,
    confirm,
    reset,
    expire,
  };
}
