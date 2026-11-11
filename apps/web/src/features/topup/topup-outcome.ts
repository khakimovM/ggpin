import {
  IdempotencyConflictDetailsSchema,
  TopupAlreadyPendingDetailsSchema,
  TopupAmountOutOfRangeDetailsSchema,
  type TopupAmountOutOfRangeDetails,
} from '@repo/shared';
import { errorDetails, isApiError, type ApiErrorCode } from '../../lib/api/errors';

/** What `POST /payments/intents` ended in, as a state of the top-up form (docs/04). */
export type CreateOutcome =
  /** 409 TOPUP_ALREADY_PENDING: the user already has a waiting request. */
  | { kind: 'pending'; intentId: string }
  /** 409 IDEMPOTENCY_CONFLICT: this key met a request that is over, or another body. */
  | { kind: 'conflict'; intentId: string }
  /** 422: outside the limits, off the step, or the daily cap; the server's numbers. */
  | { kind: 'range'; details: TopupAmountOutOfRangeDetails }
  /** 429: too many attempts; wait `retryAfterSec`. */
  | { kind: 'rate'; retryAfterSec: number | undefined }
  /** 503: no card has room, or the bank-feed listener is down. */
  | { kind: 'unavailable' }
  /** Anything else, including no answer at all: the visitor presses again (same key). */
  | { kind: 'failed'; code: ApiErrorCode };

export function classifyCreateError(error: unknown): CreateOutcome {
  if (!isApiError(error)) return { kind: 'failed', code: 'NETWORK' };
  switch (error.code) {
    case 'TOPUP_ALREADY_PENDING': {
      const details = errorDetails(error, TopupAlreadyPendingDetailsSchema);
      return details
        ? { kind: 'pending', intentId: details.intentId }
        : { kind: 'failed', code: error.code };
    }
    case 'IDEMPOTENCY_CONFLICT': {
      // Same key, but the request is over or the body differs: the caller's own request is named.
      const details = errorDetails(error, IdempotencyConflictDetailsSchema);
      return details
        ? { kind: 'conflict', intentId: details.intentId }
        : { kind: 'failed', code: error.code };
    }
    case 'TOPUP_AMOUNT_OUT_OF_RANGE': {
      const details = errorDetails(error, TopupAmountOutOfRangeDetailsSchema);
      return details ? { kind: 'range', details } : { kind: 'failed', code: error.code };
    }
    case 'RATE_LIMITED':
      return { kind: 'rate', retryAfterSec: error.retryAfterSec };
    case 'PAYMENT_METHOD_UNAVAILABLE':
      return { kind: 'unavailable' };
    default:
      return { kind: 'failed', code: error.code };
  }
}

export type RangeMessage =
  | { key: 'dailyDone' }
  | { key: 'dailyLeft'; max: string }
  | { key: 'newAccountDone' }
  | { key: 'range'; min: string; max: string; step: string };

/**
 * Which text a `422 TOPUP_AMOUNT_OUT_OF_RANGE` gets. With a `reason` it is a 24 h cap and `max` is
 * what is LEFT today: `max < min` (even 0) means the cap is used up and must never read "amount too
 * large". Compared as BigInt strings; nothing is computed.
 */
export function rangeMessage(details: TopupAmountOutOfRangeDetails): RangeMessage {
  const done = BigInt(details.max) < BigInt(details.min);
  if (details.reason === 'NEW_ACCOUNT_DAILY_LIMIT') {
    return done ? { key: 'newAccountDone' } : { key: 'dailyLeft', max: details.max };
  }
  if (details.reason === 'DAILY_LIMIT') {
    return done ? { key: 'dailyDone' } : { key: 'dailyLeft', max: details.max };
  }
  return { key: 'range', min: details.min, max: details.max, step: details.step };
}
