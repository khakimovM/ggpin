import {
  ERROR_HTTP_STATUS,
  InsufficientBalanceDetailsSchema,
  QuoteAlreadyUsedDetailsSchema,
} from '@repo/shared';
import type { InsufficientBalanceDetails } from '@repo/shared';
import { errorDetails, isApiError, type ApiError, type ApiErrorCode } from '../../lib/api/errors';

// What `POST /orders` answered, as the checkout needs it (docs/04 "Buyurtmalar"). The numbers of
// an insufficient balance are the SERVER's (`details`): the browser never works out a shortfall.
//
// Only an answer in OUR envelope (`error.fromServer`) says anything about what the handler did. A
// proxy's HTML 404 or 502 never does: the request may still have reached the API and made an order.

export type Channel = 'tg' | 'web';

export type PayOutcome =
  | { kind: 'ok'; orderId: string }
  | ({ kind: 'insufficient' } & InsufficientBalanceDetails)
  /** 410 QUOTE_EXPIRED, or the API's own 404 for a quote it does not know: a new quote is needed. */
  | { kind: 'expired' }
  /** 403 PURCHASE_FROZEN: a refunded payment limits purchases; support can lift it. */
  | { kind: 'frozen' }
  /**
   * The request left and no usable answer came back (no connection, a timeout, a 5xx, a body we
   * cannot read, an answer that is not ours): the server may have created the order and taken the
   * money. The only safe move is to ask again with the SAME quote and the SAME key.
   */
  | { kind: 'uncertain'; quoteId: string }
  /** Another window of this browser holds the purchase lock: a payment is on its way there. */
  | { kind: 'busy' }
  /** `retryAfterSec` is set for a 429 (the check waits that long). */
  | { kind: 'failed'; code: ApiErrorCode; retryAfterSec?: number };

// 408 (the gateway gave up waiting) and every 5xx say nothing about whether the handler ran.
const isNoAnswer = (status: number): boolean => status === 408 || status >= 500;

/**
 * Every answer of the order endpoint that is not a 201, as a state of the checkout. `quoteId` is
 * the quote that was sent, for the outcomes that must remember it.
 */
export function classifyOrderError(error: unknown, quoteId: string): PayOutcome {
  if (!isApiError(error)) return { kind: 'uncertain', quoteId };
  if (!error.fromServer) {
    // Never sent, or not answered by us. Two cases are certain: a 401 (the auth guard refused, or our
    // own client had no session) and our own client refusing a malformed key. Everything else
    // - NETWORK, a timeout, an HTML page, a 2xx whose body is unreadable - is doubt.
    if (error.status === 401) return { kind: 'failed', code: 'UNAUTHORIZED' };
    if (error.code === 'VALIDATION_ERROR') return { kind: 'failed', code: error.code };
    return { kind: 'uncertain', quoteId };
  }
  if (error.code === 'INTERNAL_ERROR' || error.code === 'NETWORK' || isNoAnswer(error.status)) {
    return { kind: 'uncertain', quoteId };
  }
  // A code on the wrong status (a 400 that says QUOTE_EXPIRED) is not one of our answers: a gateway
  // or a bug wrote it. Only the pairs of docs/04 count.
  if (error.status !== ERROR_HTTP_STATUS[error.code]) return { kind: 'uncertain', quoteId };
  switch (error.code) {
    case 'INSUFFICIENT_BALANCE': {
      const details = errorDetails(error, InsufficientBalanceDetailsSchema);
      // Without the server's numbers there is nothing honest to show: a plain error instead.
      return details ? { kind: 'insufficient', ...details } : { kind: 'failed', code: error.code };
    }
    case 'QUOTE_ALREADY_USED': {
      // The quote already became the caller's own order (another tab, or this one before): open it.
      const details = errorDetails(error, QuoteAlreadyUsedDetailsSchema);
      return details
        ? { kind: 'ok', orderId: details.orderId }
        : { kind: 'failed', code: error.code };
    }
    case 'QUOTE_EXPIRED':
    case 'NOT_FOUND':
      return { kind: 'expired' };
    case 'PURCHASE_FROZEN':
      return { kind: 'frozen' };
    case 'RATE_LIMITED':
      return {
        kind: 'failed',
        code: error.code,
        ...(error.retryAfterSec === undefined ? {} : { retryAfterSec: error.retryAfterSec }),
      };
    default:
      // IDEMPOTENCY_CONFLICT lands here on purpose: an ordinary error, never "refresh and go on".
      return { kind: 'failed', code: error.code };
  }
}

/**
 * Does this answer END the doubt about an attempt (so the write-ahead record may go)?
 *
 * - A FIRST attempt (no record before this send): any answer that is not itself doubtful. The
 *   server looked at the request and refused it, so no order exists.
 * - A RETRY of an unresolved attempt: only answers that prove the server looked at THIS quote:
 *   an order (201, or 409 QUOTE_ALREADY_USED with its id), 410 QUOTE_EXPIRED, 422
 *   INSUFFICIENT_BALANCE - all in our envelope - and, in the Mini App only, the API's own 404.
 *   On the web a 404 can also be the CSRF guard (D-26), which says nothing about the earlier
 *   request. A 400, 403 or 429 comes from a guard before the handler: it proves nothing either.
 */
export function resolvesAttempt(
  error: unknown,
  outcome: PayOutcome,
  channel: Channel,
  retry: boolean,
): boolean {
  if (outcome.kind === 'uncertain') return false;
  if (!retry) return true;
  if (outcome.kind === 'ok') return true;
  if (!isApiError(error) || !error.fromServer) return false;
  return resolvesRetry(error, channel);
}

function resolvesRetry(error: ApiError, channel: Channel): boolean {
  if (error.code === 'QUOTE_EXPIRED' || error.code === 'INSUFFICIENT_BALANCE') return true;
  return error.code === 'NOT_FOUND' && channel === 'tg';
}
