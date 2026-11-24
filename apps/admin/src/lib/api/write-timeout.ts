import { ApiError } from './errors';
import type { TransportRequest, TransportResponse } from './transport';

/**
 * How long an admin write (a request with an `Idempotency-Key`, and the key void) may stay without
 * an answer (N-1), and the session probe after one of its 404s (F-2). Then it is reported as
 * NETWORK, which the forms treat as "outcome unknown": the key is kept and the form stays locked
 * until «Natijani aniqlash» voids it. No client wait is needed after that: the API refuses a write
 * after 45 s (ADMIN_DEADLINE_EXCEEDED), and the void's answer is decided by the key's audit row id,
 * so a late old request either committed (APPLIED) or never will (VOIDED) (docs/04, 9-B Q2 = A).
 *
 * Keep it BELOW the server deadline (45 s, SA I-1). Above it, the panel would be waiting on a
 * request the API has already given up on: a keyed write would then come back as the deadline 503
 * ("nothing written") instead of an unknown outcome, which is right but slower, and the void —
 * which also carries this timeout — would hang past the point where its verdict is final. Below it,
 * the panel gives up first and the key void settles the outcome; that is fail-closed.
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
