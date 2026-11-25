import {
  DeliveryNotProvenError,
  LivePayoutError,
  OrderNotFoundError,
  PurchaseEntryMismatchError,
  PurchaseEntryMissingError,
  ReviewProofError,
  StaleOrderStateError,
} from '@repo/db';
import { IllegalOrderTransitionError } from '@repo/shared';
import { validationError } from '../../../common/admin/admin-input';
import { AppError } from '../../../common/exceptions/app-error';
import { isUniqueViolation } from '../../payments/db-errors';

// The @repo/db refusals as the CLI prints them (`refused: VALIDATION_ERROR {field, reason}`): the
// field and the reason, never a value. Nothing was written when any of these is thrown (the
// transaction rolled back).

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}

/** SQLSTATE `state` anywhere in a Prisma / driver adapter / pg error (a few causes deep). */
function hasSqlState(error: unknown, state: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const cause = field(field(field(current, 'meta'), 'driverAdapterError'), 'cause');
    if (field(cause, 'originalCode') === state || field(current, 'code') === state) return true;
    if (current instanceof Error && current.message.includes(state)) return true;
    current = field(current, 'cause');
  }
  return false;
}

/**
 * Postgres broke a deadlock by aborting this transaction (40P01; Prisma's P2034 "write conflict or
 * deadlock"). Everything was rolled back, so the whole transaction may run again; it is never an
 * unknown outcome (docs/06 "Qulf tartibi").
 */
export function isDeadlock(error: unknown): boolean {
  return field(error, 'code') === 'P2034' || hasSqlState(error, '40P01');
}

export const DEADLOCK_TRIES = 3;

/** Runs `work` (one whole transaction) again after a deadlock, at most DEADLOCK_TRIES times. */
export async function retryOnDeadlock<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isDeadlock(error) || attempt >= DEADLOCK_TRIES) throw error;
    }
  }
}

/** A guard trigger of the database refused the write (GG001): the rows moved under us. */
export function isGuardRefusal(error: unknown): boolean {
  return hasSqlState(error, 'GG001');
}

/**
 * The partial unique indexes behind "one bounce / one finding pays one refund" (migration
 * p5_orders_fulfillment_checks): two resolutions of DIFFERENT orders naming the same return or
 * consuming transaction both pass the query check before either commits; the second commit's
 * AuditLog insert then fails on the index (P2002). The same refusal as the query check (CR m5).
 */
const REUSED_TX_INDEX: Readonly<Record<string, 'RETURN_TX_REUSED' | 'CONSUMING_TX_REUSED'>> = {
  AuditLog_review_return_tx_key: 'RETURN_TX_REUSED',
  AuditLog_review_consuming_tx_key: 'CONSUMING_TX_REUSED',
};

function reusedTx(error: unknown): 'RETURN_TX_REUSED' | 'CONSUMING_TX_REUSED' | null {
  for (const [index, reason] of Object.entries(REUSED_TX_INDEX)) {
    if (isUniqueViolation(error, index)) return reason;
  }
  return null;
}

/** An @repo/db or database refusal as an AppError; anything else is returned unchanged. */
export function asRefusal(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof OrderNotFoundError) return new AppError('NOT_FOUND');
  if (error instanceof ReviewProofError) return validationError('proof', error.problem);
  if (error instanceof StaleOrderStateError) return validationError('order', 'STATE_CHANGED');
  if (error instanceof LivePayoutError) return validationError('order', 'LIVE_PAYOUT');
  if (error instanceof DeliveryNotProvenError) {
    return validationError('order', 'DELIVERY_NOT_PROVEN');
  }
  if (error instanceof PurchaseEntryMissingError) {
    return validationError('order', 'PURCHASE_ENTRY_MISSING');
  }
  if (error instanceof PurchaseEntryMismatchError) {
    return validationError('order', 'PURCHASE_ENTRY_MISMATCH');
  }
  if (error instanceof IllegalOrderTransitionError) {
    return validationError('order', 'ILLEGAL_TRANSITION');
  }
  const reused = reusedTx(error);
  if (reused !== null) return validationError('proof', reused);
  if (isGuardRefusal(error)) return validationError('order', 'GUARD_REFUSED');
  return error;
}
