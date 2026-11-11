import type { PayView } from '@repo/shared';
import { isApiError } from '../../lib/api/errors';

export type PayScreen =
  'loading' | 'pay' | 'credited' | 'expired' | 'cancelled' | 'invalid' | 'done' | 'failed';

export interface PayScreenInput {
  /** `undefined` until hydrated, `null` when the link has no usable token (or it was erased). */
  token: string | null | undefined;
  data: PayView | undefined;
  error: unknown;
  /** Milliseconds to `expiresAt` on this device's clock (0 once past); only for display. */
  msLeft: number;
  /** A finished request is on record for this tab (a marker with no secret in it). */
  done?: boolean;
}

/**
 * Which screen the pay page shows. The server decides the STATUS; the clock only tells an expired
 * request apart from a token that died early (cancelled, or replaced by a newer link): after
 * `expiresAt` the API answers 404 for the token, which must read "expired", not "invalid".
 */
export function payScreenOf({
  token,
  data,
  error,
  msLeft,
  done = false,
}: PayScreenInput): PayScreen {
  if (token === undefined) return 'loading';
  const missing = isApiError(error) && error.status === 404;
  if (data === undefined) {
    // No usable token for a request that is on record as finished: say so, show nothing of it.
    if (token === null || missing) return done ? 'done' : 'invalid';
    return error === null || error === undefined ? 'loading' : 'failed';
  }
  // An answer that says the request has ended stands even after the token was erased.
  if (data.status === 'PAID') return 'credited';
  if (data.status === 'CANCELLED') return 'cancelled';
  if (data.status === 'EXPIRED') return 'expired';
  if (msLeft <= 0) return 'expired';
  return token === null || missing ? 'invalid' : 'pay';
}

/** A failed poll that left the last good answer on screen (the "not updated" bar). */
export function isStale(data: PayView | undefined, error: unknown): boolean {
  if (data === undefined || error === null || error === undefined) return false;
  return !(isApiError(error) && error.status === 404);
}
