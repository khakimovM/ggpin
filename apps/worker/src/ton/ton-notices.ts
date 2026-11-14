import type { FulfillmentAlertKind, NotifyJob, OrderStatusReason } from '@repo/shared';
import { isUnresolved, type PayoutState } from './ton-payout';

// What the TON module tells the customer and the owner (plan §5, S6 renders it). The notices are
// derived from the FINAL rows, not from the step that produced them, so a replay (a retried job,
// a second check of a settled transfer) produces the same notices again; their notify job ids are
// stable per event (notifyJobId), so a repeat is dropped by BullMQ and nobody hears twice.

export type TonNotice =
  | { readonly kind: 'ORDER_DELIVERED' | 'ORDER_REVIEW'; readonly orderId: string }
  | { readonly kind: 'ALERT'; readonly alert: FulfillmentAlertKind; readonly refId: string };

function alert(kind: FulfillmentAlertKind, refId: string): TonNotice {
  return { kind: 'ALERT', alert: kind, refId };
}

/** The notices one transfer's state calls for. */
export function tonNoticesFor(state: PayoutState): TonNotice[] {
  const notices: TonNotice[] = [];
  const orderId = state.orderId;
  if (
    orderId !== null &&
    state.orderStatus === 'DELIVERED' &&
    state.transferStatus === 'CONFIRMED'
  ) {
    notices.push({ kind: 'ORDER_DELIVERED', orderId });
  }
  if (orderId !== null && state.orderStatus === 'NEEDS_REVIEW') {
    notices.push({ kind: 'ORDER_REVIEW', orderId }, alert('needsReview', orderId));
  }
  // CRITICAL: the seqno was used by a message that is not ours (someone else may hold the key).
  if (state.transferStatus === 'CONSUMED_UNMATCHED') {
    notices.push(alert('tonSeqnoUnmatched', state.transferId));
  }
  // CRITICAL: the destination refused the payment and the value came back (docs/06 A1).
  if (state.transferStatus === 'BOUNCED') notices.push(alert('tonBounced', state.transferId));
  // CRITICAL: an expiry witness contradicted "not sent" (review m3). From the kept fact, not from
  // the look that saw it, so a lost enqueue is sent again by the next look (review RR2-4).
  if (state.witnessConflict) notices.push(witnessConflictNotice(state.transferId));
  // CRITICAL: the order went to review (SUSPECT, TIMEOUT) while its transfer stays unresolved, so
  // every later TON payout waits for a decision (review M4). Once per blocking transfer.
  if (
    orderId !== null &&
    state.orderStatus === 'NEEDS_REVIEW' &&
    isUnresolved(state.transferStatus)
  ) {
    notices.push(walletBlockedNotice(state.transferId));
  }
  return notices;
}

/**
 * CRITICAL (review m3): an expiry witness saw our message or a moved seqno while the primary
 * source said "not sent". One of the two sources lies or lags; the order went to review, never
 * EXPIRED. refId = the transfer, so every look that repeats it is the same job.
 */
export function witnessConflictNotice(transferId: string): TonNotice {
  return alert('tonWitnessConflict', transferId);
}

/** The hot wallet is blocked by this unresolved transfer (review M4, audit L3). */
export function walletBlockedNotice(transferId: string): TonNotice {
  return alert('tonWalletBlocked', transferId);
}

/**
 * The wallet's unresolved transfer has outlived TON_CONFIRM_TIMEOUT_MS by the database clock: no
 * sender will settle it any more, only the reconciler or the owner (a WALLET_BUSY that lasts).
 */
export function blocksWallet(createdAt: Date, databaseNowMs: number, confirmTimeoutMs: number) {
  return databaseNowMs - createdAt.getTime() > confirmTimeoutMs;
}

/**
 * An order held before anything was signed: the customer hears "being checked" (once per order),
 * the owner why. The owner's refId is `<orderId>_<attemptId>` (review m7): a replay of the same
 * hold repeats the ids, a later hold of the same order (after a reconcile, D-56 (4)) is a new
 * attempt and is heard again.
 */
export function heldNotices(
  orderId: string,
  attemptId: string,
  reason: OrderStatusReason,
): TonNotice[] {
  const ref = `${orderId}_${attemptId}`;
  const notices: TonNotice[] = [{ kind: 'ORDER_REVIEW', orderId }, alert('held', ref)];
  if (reason === 'LIMIT_DAILY') notices.push(alert('tonDailyLimit', ref));
  return notices;
}

export function noticeJob(notice: TonNotice): NotifyJob {
  return notice.kind === 'ALERT'
    ? { kind: 'OWNER_ALERT', alert: notice.alert, refId: notice.refId }
    : { kind: notice.kind, refId: notice.orderId };
}
