import { createHash } from 'node:crypto';
import { AdminConfirmSetSchema, type AdminOpenOrderStatus } from '@repo/shared';
import { validationError } from '../../common/admin/admin-input';

// I-5 (owner decision 2026-11-22, docs/04 «Ochiq buyurtmalar»): a positive wallet adjustment for
// a user with orders still in flight (ADMIN_OPEN_ORDER_STATUSES) needs the id of exactly that set.
// A HELD or NEEDS_REVIEW order may still be refunded automatically: compensation given by hand
// on top of that refund would pay the user twice. The owner confirms what he saw; the server
// recomputes the set under the wallet lock (order creation and refunds hold the same lock).

/** An open order of the user: what the owner is shown before he confirms the set. */
export interface OpenOrder {
  readonly id: string;
  readonly number: number;
  readonly status: AdminOpenOrderStatus;
  readonly priceTiyin: bigint;
  readonly createdAt: Date;
}

/** The refusal's reason: `400 fields[{ path: "user", code: "OPEN_ORDERS" }]` on the panel. */
export const OPEN_ORDERS_REASON = 'OPEN_ORDERS';

/** The CLI prints at most this many of them; the set id covers all of them. */
export const OPEN_ORDERS_SHOWN = 20;

/**
 * 12 hex characters of the sha256 of ALL the open orders' sorted ids (prefixed, so it can never
 * equal a top-up set id of the same ids). Short, because the bot's code message shows it too.
 */
export function openOrdersSetHash(open: readonly Pick<OpenOrder, 'id'>[]): string {
  const ids = open.map((order) => order.id).sort();
  return createHash('sha256')
    .update(`open-orders|${ids.join(',')}`)
    .digest('hex')
    .slice(0, 12);
}

/** `confirmOpenOrdersSet` / `--confirm-open-orders`: absent, or the 12-hex set id. */
export function checkedOpenOrdersSet(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!AdminConfirmSetSchema.safeParse(value).success) {
    throw validationError('confirmOpenOrdersSet');
  }
  return value;
}

/**
 * Whether the adjustment may go ahead. A debit is never held back by open orders (`openFor` reads
 * none for it, and a set sent with it is ignored). For a credit: without a given set, only when
 * nothing is open; with a given set, only when it is the id of the very set read now, EVEN when
 * nothing is open any more (CR #2, fail-closed): the owner confirmed compensation next to orders
 * that have closed since, and one of them may just have been refunded automatically. The empty
 * set has its own id, so a stale set can never pass.
 */
export function openOrdersConfirmed(
  amountTiyin: bigint,
  open: readonly Pick<OpenOrder, 'id'>[],
  given: string | undefined,
): boolean {
  if (amountTiyin <= 0n) return true;
  if (given === undefined) return open.length === 0;
  return given === openOrdersSetHash(open);
}

/**
 * The binding flag of the open orders (the code confirms the set as it was when issued); empty
 * without any. Same style as the override flag, so admin-otp-flags.ts reads it into words.
 */
export function openOrdersFlag(open: readonly Pick<OpenOrder, 'id'>[]): string {
  if (open.length === 0) return '';
  return `open orders: ${String(open.length)} open order(s), set ${openOrdersSetHash(open)}`;
}
