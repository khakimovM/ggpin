import { AppError } from '../../common/exceptions/app-error';

/**
 * D-49: the order a `(userId, Idempotency-Key)` already made IS the replay record (no separate
 * store, no expiry). It is looked up under the wallet lock BEFORE any quote check, so a retry
 * whose answer was lost gets its order back even after the quote expired or was marked used.
 *
 * - no order under the key: `null`, the purchase goes on;
 * - the same body (same hash): that order, answered again with 201 and no second debit;
 * - another body under the key: 409 IDEMPOTENCY_CONFLICT without details (the stored order is
 *   not shown to a request that does not match it).
 */
export function replayOf<T extends { readonly requestHash: string }>(
  stored: T | null,
  requestHash: string,
): T | null {
  if (stored === null) return null;
  if (stored.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT');
  return stored;
}
