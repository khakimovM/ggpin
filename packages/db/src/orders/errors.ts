import type { OrderStatus } from '@repo/shared';

/** No order with this id. Callers that act on a user's own order turn it into a 404 themselves. */
export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'OrderNotFoundError';
  }
}

/**
 * The compare-and-set found the order in another state than the caller expected: somebody else
 * (a retry, the reconciler, an operator) moved it first. Nothing was written. The caller decides
 * what that means, usually "already done, stop".
 *
 * Do not catch it INSIDE the transaction and carry on: it is thrown before any write, but the
 * transaction is the caller's, and "I lost the race" must end it, not continue it.
 */
export class StaleOrderStateError extends Error {
  constructor(
    readonly orderId: string,
    readonly expected: OrderStatus,
  ) {
    super(`Order ${orderId} is no longer ${expected}`);
    this.name = 'StaleOrderStateError';
  }
}

/**
 * The edge is legal in order-state.ts but is not a plain status change: NEEDS_REVIEW can only be
 * left through `resolveNeedsReview` (with a proof) and REFUNDED is only reached through the
 * refund helpers (which write the ledger entry). Audit H2.
 */
export class RestrictedTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Order transition ${from} -> ${to} is only available through its dedicated helper`);
    this.name = 'RestrictedTransitionError';
  }
}

/** A move into HELD / NEEDS_REVIEW / FAILED without the reason that explains it (review F7). */
export class MissingStatusReasonError extends Error {
  constructor(
    readonly orderId: string,
    readonly to: OrderStatus,
  ) {
    super(`Order ${orderId}: a transition to ${to} needs a status reason`);
    this.name = 'MissingStatusReasonError';
  }
}

/** An operator acted without an id: the order event and the audit row must name who did it. */
export class ActorRefRequiredError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId}: an admin transition needs the operator id (actorRef)`);
    this.name = 'ActorRefRequiredError';
  }
}

/**
 * The order's own rows say a payout may have gone out (an attempt that is SENDING / SENT /
 * UNKNOWN / CONFIRMED, or a TON transfer that is not provably EXPIRED), so it cannot be failed,
 * held or refunded as "not sent". Nothing was written. Audit H2.
 */
export class LivePayoutError extends Error {
  constructor(
    readonly orderId: string,
    readonly detail: string,
  ) {
    super(`Order ${orderId} has a payout that may have gone out: ${detail}`);
    this.name = 'LivePayoutError';
  }
}

/**
 * The order cannot become DELIVERED: it has no CONFIRMED attempt, an attempt still waits for its
 * outcome, or a TON transfer is signed, broadcast, consumed-unmatched or bounced (audit Y1, L5).
 * Nothing was written.
 */
export class DeliveryNotProvenError extends Error {
  constructor(
    readonly orderId: string,
    readonly detail: string,
  ) {
    super(`Order ${orderId} cannot be DELIVERED: ${detail}`);
    this.name = 'DeliveryNotProvenError';
  }
}

/** The refund would credit money no PURCHASE entry took (review F2, audit M4). */
export class PurchaseEntryMissingError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} has no PURCHASE ledger entry: nothing to refund`);
    this.name = 'PurchaseEntryMissingError';
  }
}

/** The PURCHASE entry and the order disagree about what was paid: a human must look. */
export class PurchaseEntryMismatchError extends Error {
  constructor(
    readonly orderId: string,
    readonly orderTotalTiyin: bigint,
    readonly purchasedTiyin: bigint,
  ) {
    super(
      `Order ${orderId}: the PURCHASE entry took ${purchasedTiyin.toString()} tiyin but the order total is ${orderTotalTiyin.toString()}`,
    );
    this.name = 'PurchaseEntryMismatchError';
  }
}

export type ReviewProofProblem =
  /** No proof, or one that does not match NeedsReviewProofSchema. */
  | 'INVALID'
  /** A proof of a kind that cannot justify this exit (e.g. TON_TX used to refund). */
  | 'WRONG_KIND'
  /** The resolver is malformed: an operator without an id, a field of the wrong type (audit L2). */
  | 'OPERATOR_REQUIRED'
  /** A proof only an operator may carry (MANUAL, FRAGMENT_STATUS, the owner-only ones), signed by the reconciler. */
  | 'ACTOR_MISMATCH'
  /**
   * The proof needs an OWNER who typed the OTP: the ADMIN is not an active OWNER in `AdminUser`
   * (the role is read from the database, never from the caller: audit L3) or `otpVerified` is not
   * `true` (audit L2). Rules/60: a refund or a manual delivery is an OWNER + OTP action.
   */
  | 'OWNER_REQUIRED'
  /** The return transaction of a TON_BOUNCED proof already paid out another refund (audit R2e). */
  | 'RETURN_TX_REUSED'
  /** The consuming transaction of a TON_UNMATCHED_RESOLVED proof already paid out another refund (Z5). */
  | 'CONSUMING_TX_REUSED'
  /** The proof does not match the order's own attempts and transfers (or names none of them). */
  | 'MISMATCH'
  /** The proof matches, but another payout of the order may still have gone out. */
  | 'LIVE_PAYOUT';

/** `resolveNeedsReview` was called without a proof that justifies the exit. Nothing was written. */
export class ReviewProofError extends Error {
  constructor(
    readonly problem: ReviewProofProblem,
    readonly orderId: string,
  ) {
    super(`Order ${orderId} cannot leave NEEDS_REVIEW: ${problem}`);
    this.name = 'ReviewProofError';
  }
}
