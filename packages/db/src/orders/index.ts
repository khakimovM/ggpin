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
export { resolveNeedsReview } from './needs-review-resolve.js';
export type {
  ResolveNeedsReviewInput,
  ResolveNeedsReviewResult,
  ReviewResolver,
  SecurityAlertKey,
} from './needs-review-resolve.js';
export { failAndRefundOrder, refundFailedOrder } from './order-refund.js';
export type { FailAndRefundInput, RefundFailedOrderInput, RefundOutcome } from './order-refund.js';
export { transitionOrder } from './order-transition.js';
export type { OrderTransitionInput, ReasonedStatus } from './order-transition.js';
