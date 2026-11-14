import type { AttemptStatus, TonTransferStatus } from '@repo/db';
import type { OrderStatus, OrderStatusReason, TonLimitRefusal } from '@repo/shared';
import type { Cell } from '@ton/core';

// The contract between the TON module (S5) and the fulfillment core / the Fragment adapter (S4,
// S8). `pay` is called only after the FulfillmentAttempt row was committed SENDING (rules/45 step
// 5). Every decided outcome is a result, and the TON module itself writes the order transitions
// the database demands atomically with the transfer (DELIVERED with the CONFIRMED transfer and
// attempt, NEEDS_REVIEW with BOUNCED / CONSUMED_UNMATCHED, HELD with the failed attempt when a
// limit, the balance or the payee allowlist refuses before signing).
//
// A THROW means "outcome unknown" (review m2), never "not sent": the database may have committed
// the SIGNED transfer and lost the answer, Redis may be down, the request may be malformed. A
// retry of the same attempt is ALWAYS safe (it finds the attempt's transfer and only follows it;
// nothing is signed or broadcast twice), and a throw is never a reason for FAILED, HELD or a
// refund (S4).

export interface TonPayRequest {
  readonly orderId: string;
  readonly attemptId: string;
  /**
   * Where the value goes (raw or user-friendly). Must be in FRAGMENT_PAY_ADDRESSES (workchain 0):
   * any other address holds the order before anything is signed (audit L1).
   */
  readonly toAddress: string;
  readonly amountNano: bigint;
  /** The message body the payee asked for (Fragment's payload cell); its cell hash is stored. */
  readonly payload: Cell;
}

/**
 * Nothing was signed by THIS call and the job may retry later. With WALLET_BUSY the attempt may
 * already own a transfer signed by an earlier call (a lock held by a dead worker): a retry then
 * follows that transfer (review m1).
 */
export type TonNotSentReason = 'WALLET_BUSY' | 'WALLET_NOT_READY' | 'CLOCK_SKEW' | 'GATEWAY';

/**
 * Nothing was signed or written because the order or the attempt is no longer the one the job
 * was started for (docs/06: a worker that stalled and woke after an operator failed the order).
 */
export type TonStopReason =
  | 'ORDER_NOT_PROCESSING'
  | 'ATTEMPT_NOT_SENDING'
  | 'ATTEMPT_HAS_TRANSFER'
  | 'REF_TAKEN'
  | 'GUARD_REFUSED';

/** ADAPTER_ERROR: the payout address is not in FRAGMENT_PAY_ADDRESSES (attempt error says so). */
export type TonHoldReason = TonLimitRefusal | 'LOW_BALANCE' | 'ADAPTER_ERROR';

export type TonPayResult =
  /** The transfer is CONFIRMED, the attempt CONFIRMED and the order DELIVERED (one transaction). */
  | { readonly status: 'DELIVERED'; readonly transferId: string; readonly txHash: string }
  /**
   * The outcome needs a human or the reconciler: the order is NEEDS_REVIEW (or, when even that
   * write failed, still PROCESSING: `orderStatus` says which, null when the DB could not be read).
   */
  | {
      readonly status: 'REVIEW';
      readonly transferId: string;
      readonly orderStatus: OrderStatus | null;
      readonly transferStatus: TonTransferStatus | null;
    }
  /** Provably never sent (EXPIRED): the attempt is FAILED, the order still PROCESSING. */
  | { readonly status: 'EXPIRED'; readonly transferId: string }
  /** A limit, the balance or the allowlist refused before signing: attempt FAILED, order HELD. */
  | { readonly status: 'HELD'; readonly reason: TonHoldReason }
  | { readonly status: 'NOT_SENT'; readonly reason: TonNotSentReason }
  | { readonly status: 'STOPPED'; readonly reason: TonStopReason };

/** The rows of one transfer after a check or an outcome, read under the transaction's locks. */
export interface PayoutState {
  readonly transferId: string;
  readonly transferStatus: TonTransferStatus;
  readonly txHash: string | null;
  readonly orderId: string | null;
  readonly orderStatus: OrderStatus | null;
  readonly orderReason: OrderStatusReason | null;
  readonly attemptStatus: AttemptStatus | null;
  /** An expiry witness contradicted "not sent" (review m3, RR2-4): never EXPIRED, the owner hears. */
  readonly witnessConflict: boolean;
}

export const UNRESOLVED_TRANSFER: readonly TonTransferStatus[] = ['SIGNED', 'BROADCAST'];

export function isUnresolved(status: TonTransferStatus): boolean {
  return UNRESOLVED_TRANSFER.includes(status);
}

/**
 * The worker's part is over: the transfer is decided, or its order left PROCESSING. A transfer
 * without an order (the testnet self-test) is watched until the chain decides it.
 */
export function isSettled(state: PayoutState): boolean {
  if (!isUnresolved(state.transferStatus)) return true;
  return state.orderId !== null && state.orderStatus !== 'PROCESSING';
}

export function payResultOf(transferId: string, state: PayoutState | null): TonPayResult {
  if (state === null) {
    return { status: 'REVIEW', transferId, orderStatus: null, transferStatus: null };
  }
  if (
    state.transferStatus === 'CONFIRMED' &&
    state.orderStatus === 'DELIVERED' &&
    state.txHash !== null
  ) {
    return { status: 'DELIVERED', transferId, txHash: state.txHash };
  }
  if (state.transferStatus === 'EXPIRED' && state.orderStatus === 'PROCESSING') {
    return { status: 'EXPIRED', transferId };
  }
  return {
    status: 'REVIEW',
    transferId,
    orderStatus: state.orderStatus,
    transferStatus: state.transferStatus,
  };
}
