import { ApiError } from './errors';
import type { TransportRequest, TransportResponse } from './transport';

/**
 * How long an admin write (a request with an `Idempotency-Key`) may stay without an answer (N-1),
 * and the session probe after one of its 404s (F-2). Then it is reported as NETWORK, which the
 * forms treat as "outcome unknown": the key is kept and "start as a new action" waits 60 s from
 * this end. What the server can spend on a write (the API sets no Fastify request timeout): waits
 * for a pg pool connection before the transaction (up to 5 s each), Redis calls (~5-10 s worst
 * case), then the transaction (card and review-credit: 4 s maxWait + 15 s, card-lock-timing.ts;
 * user and wallet: Prisma's 2 s + 5 s). 30 s alone does NOT cover all of that: the margin is
 * 30 s + OUTCOME_WAIT_MS (60 s) after the end, ~90 s from the send; the hard guarantee is the
 * server voiding the old key (SA-1, phase 9-B).
 */
export const WRITE_TIMEOUT_MS = 30_000;

/**
 * Sends `request` and gives up after `ms`: the fetch is aborted (so the browser drops it) and a
 * NETWORK error is thrown. An abort by the caller's own signal still arrives as that abort.
 */
export async function sendWithTimeout(
  send: (request: TransportRequest) => Promise<TransportResponse>,
  request: TransportRequest,
  ms: number = WRITE_TIMEOUT_MS,
): Promise<TransportResponse> {
  const controller = new AbortController();
  const outer = request.signal;
  // Without a reason (I-5): the fetch then rejects with a plain AbortError, which `send` passes on
  // as the caller's abort; a custom reason would surface as NETWORK instead.
  const forward = () => controller.abort();
  if (outer?.aborted === true) forward();
  else outer?.addEventListener('abort', forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: the race must end with "no answer", not with the abort it causes.
      reject(new ApiError({ status: 0, code: 'NETWORK' }));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([send({ ...request, signal: controller.signal }), timedOut]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}
