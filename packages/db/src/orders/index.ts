// `applyTransition` (order-transition-core.ts) is deliberately NOT exported: it is the unrestricted
// writer that only `resolveNeedsReview` and the refund helpers may use (audit H2).
export {
  ActorRefRequiredError,
  DeliveryNotProvenError,
  LivePayoutError,
  MissingStatusReasonError,
  OrderNotFoundError,
  PurchaseEntryMismatchError,
  PurchaseEntryMissingError,
  RestrictedTransitionError,
  ReviewProofError,
  StaleOrderStateError,
} from './errors.js';
export type { ReviewProofProblem } from './errors.js';
export { REVIEW_ACKNOWLEDGEMENTS, resolveNeedsReview } from './needs-review-resolve.js';
export type {
  ResolveNeedsReviewInput,
  ResolveNeedsReviewResult,
  ReviewAcknowledgement,
  ReviewResolver,
  SecurityAlertKey,
} from './needs-review-resolve.js';
export { failAndRefundOrder, refundFailedOrder } from './order-refund.js';
export type { FailAndRefundInput, RefundFailedOrderInput, RefundOutcome } from './order-refund.js';
export { transitionOrder } from './order-transition.js';
export { TON_LATE_FACT_KEYS, hasLateTonFact } from './payout-state.js';
export type { OrderTransitionInput, ReasonedStatus } from './order-transition.js';
