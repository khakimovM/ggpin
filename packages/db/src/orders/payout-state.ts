import type { AttemptStatus, TonTransferStatus } from '../generated/prisma/client.js';
import { assertInTransaction, type Tx } from '../ledger/ledger.js';
import { LivePayoutError } from './errors.js';

// What an order's own rows say about money that may have left the company. Every helper that
// fails, holds or refunds an order reads this UNDER LOCK and refuses when a payout may be in
// flight (audit H2): "no live payout" is the only state in which "not sent" is true.
//
// LOCK ORDER (review R8), the same in every helper, in the SQL guards of migration 10 and in the
// worker (docs/06): wallet -> order -> attempt -> transfer. A transaction that takes a lock out of
// this order can deadlock with one that keeps it; Postgres then aborts one of them, which is safe
// but must not be provoked. Take the wallet lock only when money moves (FAILED, CANCELLED, REFUNDED).

/** Attempts whose outcome is not a provable "not sent": in flight, or already paid. */
export const LIVE_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'SENDING',
  'SENT',
  'UNKNOWN',
  'CONFIRMED',
];

/** Attempts still waiting for an outcome (the ones `resolveNeedsReview` may close). */
export const UNRESOLVED_ATTEMPT_STATUSES: readonly AttemptStatus[] = ['SENDING', 'SENT', 'UNKNOWN'];

export interface PayoutAttempt {
  readonly id: string;
  readonly status: AttemptStatus;
  readonly externalRef: string | null;
  /** When the attempt was committed SENDING: the "is the worker still running?" clock starts here. */
  readonly createdAt: Date;
}

export interface PayoutTransfer {
  readonly id: string;
  readonly attemptId: string | null;
  readonly status: TonTransferStatus;
  readonly extMsgHash: string;
  readonly walletAddress: string;
  readonly seqno: number;
  readonly amountNanoTon: bigint;
  readonly validUntil: Date;
  readonly txHash: string | null;
  readonly txLt: bigint | null;
}

export interface PayoutState {
  readonly attempts: readonly PayoutAttempt[];
  readonly transfers: readonly PayoutTransfer[];
}

/**
 * Locks the order row (`SELECT ... FOR UPDATE`) so the order, its attempts and its transfers are
 * read as one state and a concurrent transition waits. Lock order everywhere: wallet, then order.
 */
export async function lockOrderRow(tx: Tx, orderId: string): Promise<void> {
  assertInTransaction(tx, 'lockOrderRow');
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
}

export async function readPayoutState(tx: Tx, orderId: string): Promise<PayoutState> {
  const attempts = await tx.fulfillmentAttempt.findMany({
    where: { orderId },
    select: { id: true, status: true, externalRef: true, createdAt: true },
    orderBy: { attemptNo: 'asc' },
  });
  const transfers = await tx.tonTransfer.findMany({
    where: { attempt: { orderId } },
    select: {
      id: true,
      attemptId: true,
      status: true,
      extMsgHash: true,
      walletAddress: true,
      seqno: true,
      amountNanoTon: true,
      validUntil: true,
      txHash: true,
      txLt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return { attempts, transfers };
}

/**
 * The transfers whose state a human has to read before any refund (owner decisions A1-A4, D-59):
 * the action phase failed (`ONCHAIN_FAILED`), the destination bounced the value back
 * (`BOUNCED`), or the seqno went to an unknown transaction (`CONSUMED_UNMATCHED`). Only an
 * OWNER's proof, bound by `resolveNeedsReview`, lets the order past them.
 */
export const REVIEW_ONLY_TRANSFER_STATUSES: readonly TonTransferStatus[] = [
  'ONCHAIN_FAILED',
  'BOUNCED',
  'CONSUMED_UNMATCHED',
];

/**
 * Throws `LivePayoutError` unless "not sent" is provable from the rows: no attempt in flight or
 * confirmed, and every TON transfer EXPIRED (a message that can never be accepted). A transfer
 * that is SIGNED, BROADCAST, CONFIRMED, failed on chain, bounced or consumed without a match all
 * count as "may have gone out".
 *
 * `provenTransferIds` is set only inside `resolveNeedsReview`, after an OWNER's proof was bound
 * to exactly those transfers (TON_NOT_DEBITED, TON_BOUNCED, TON_UNMATCHED_RESOLVED): such a
 * transfer, and only if its status is one of the three review-only ones, no longer counts.
 */
export function assertNoLivePayout(
  orderId: string,
  state: PayoutState,
  options: { readonly provenTransferIds?: readonly string[] } = {},
): void {
  const attempt = state.attempts.find((a) => LIVE_ATTEMPT_STATUSES.includes(a.status));
  if (attempt !== undefined) throw new LivePayoutError(orderId, `attempt is ${attempt.status}`);
  const proven = options.provenTransferIds ?? [];
  const transfer = state.transfers.find(
    (t) =>
      t.status !== 'EXPIRED' &&
      !(proven.includes(t.id) && REVIEW_ONLY_TRANSFER_STATUSES.includes(t.status)),
  );
  if (transfer !== undefined) throw new LivePayoutError(orderId, `transfer is ${transfer.status}`);
}

export type DeliveryProblem =
  /** No attempt of the order is (or is about to be) CONFIRMED. */
  | { readonly kind: 'NO_CONFIRMED_ATTEMPT'; readonly detail: string }
  /** An attempt is still SENDING / SENT / UNKNOWN. */
  | { readonly kind: 'UNRESOLVED_ATTEMPT'; readonly detail: string }
  /** A transfer is signed, broadcast, consumed-unmatched or bounced. */
  | { readonly kind: 'TRANSFER_NOT_SETTLED'; readonly detail: string }
  /**
   * An attempt that is (or is about to be) CONFIRMED has its OWN transfer EXPIRED or ONCHAIN_FAILED:
   * the payout did not go out, so only the owner's MANUAL proof can say it was delivered anyway (Z3).
   */
  | { readonly kind: 'OWN_TRANSFER_NOT_PAID'; readonly detail: string };

/** The transfers an order may carry and still be DELIVERED (the SQL guard's list). */
const DELIVERABLE_TRANSFER_STATUSES: readonly TonTransferStatus[] = [
  'CONFIRMED',
  'EXPIRED',
  'ONCHAIN_FAILED',
];

/**
 * What stands between this order and DELIVERED, or null (audit Y1, L5; the same rule as the SQL
 * guard of `Order`): at least one CONFIRMED attempt, no attempt still waiting for its outcome,
 * and every transfer CONFIRMED, EXPIRED or ONCHAIN_FAILED (none signed, broadcast,
 * consumed-unmatched or bounced). `closing` are the unresolved attempts the caller closes to
 * CONFIRMED in the same transaction (`resolveNeedsReview`), judged as already CONFIRMED.
 *
 * The OTHER transfers of the order (earlier attempts) may be EXPIRED or ONCHAIN_FAILED; the OWN
 * transfer of an attempt that is CONFIRMED may not, unless the delivery is the owner's MANUAL
 * proof (`manual`, the deferred check `FulfillmentAttempt_confirmed_check` of the SQL, Z3): then
 * the owner says the payout was made outside the system. An attempt without a transfer (a
 * supplier attempt) or with a CONFIRMED one is always fine.
 */
export function deliveryProblem(
  state: PayoutState,
  closing: readonly PayoutAttempt[] = [],
  options: { readonly manual?: boolean } = {},
): DeliveryProblem | null {
  const closingIds = new Set(closing.map((a) => a.id));
  const statusOf = (a: PayoutAttempt): AttemptStatus =>
    closingIds.has(a.id) ? 'CONFIRMED' : a.status;
  const waiting = state.attempts.find((a) => UNRESOLVED_ATTEMPT_STATUSES.includes(statusOf(a)));
  if (waiting !== undefined) {
    return { kind: 'UNRESOLVED_ATTEMPT', detail: `attempt is ${statusOf(waiting)}` };
  }
  const unsettled = state.transfers.find((t) => !DELIVERABLE_TRANSFER_STATUSES.includes(t.status));
  if (unsettled !== undefined) {
    return { kind: 'TRANSFER_NOT_SETTLED', detail: `transfer is ${unsettled.status}` };
  }
  const confirmed = state.attempts.filter((a) => statusOf(a) === 'CONFIRMED');
  if (confirmed.length === 0) {
    return { kind: 'NO_CONFIRMED_ATTEMPT', detail: 'no attempt is CONFIRMED' };
  }
  if (options.manual !== true) {
    const own = state.transfers.find(
      (t) =>
        (t.status === 'EXPIRED' || t.status === 'ONCHAIN_FAILED') &&
        confirmed.some((a) => a.id === t.attemptId),
    );
    if (own !== undefined) {
      return {
        kind: 'OWN_TRANSFER_NOT_PAID',
        detail: `the confirmed attempt's own transfer is ${own.status}`,
      };
    }
  }
  return null;
}

/**
 * The database's own clock, read inside the transaction. Every "has enough time passed?" rule of the
 * helpers uses it, and so do the SQL guards (`now()`), so a helper and a guard can never disagree
 * about the time, and no caller can hand in a clock (audit N2). `now()` is the start of the
 * transaction: a transaction that waited for a lock reads an earlier time, which is the safe way
 * round for "at least this long ago" and for "not in the future".
 *
 * It is read as seconds since the epoch (audit L1), never as a `timestamptz` value: the driver
 * adapter turns a `timestamptz` into a JS date without converting its offset, so a session whose
 * TimeZone is not UTC (Asia/Tashkent, +5 h) would shift the clock by hours and switch the age rule
 * and the `checkedAt` rule off. An epoch number does not depend on the session's TimeZone at all.
 * The client also pins `TimeZone=UTC` for its sessions (`createPrismaClient`).
 */
export async function readDatabaseNow(tx: Tx): Promise<Date> {
  assertInTransaction(tx, 'readDatabaseNow');
  const rows = await tx.$queryRaw<{ ms: bigint }[]>`
    SELECT floor(extract(epoch FROM now()) * 1000)::bigint AS "ms"`;
  const row = rows[0];
  if (row === undefined) throw new Error('the database returned no clock');
  return new Date(Number(row.ms));
}
