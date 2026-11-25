// Why an order sits in HELD / NEEDS_REVIEW / FAILED. Stored in `Order.statusReason` and read by
// the owner CLI, the reconciler and the alert renderers. INTERNAL: OrderSchema has no such field,
// the customer only sees the status group (docs/04 "Buyurtma holatlari klientda"). A closed list
// on purpose: a free-text reason cannot be counted, alerted on or translated.
import { z } from 'zod';

export const ORDER_STATUS_REASONS = [
  // HELD: the real cost is above the ceiling stored on the order (`Order.maxCostMinor`).
  'PRICE_ABOVE_MAX',
  // HELD: the TON_MAX_PER_ORDER_NANO / rolling 24 h TON_MAX_DAILY_NANO limit would be crossed.
  'LIMIT_PER_ORDER',
  'LIMIT_DAILY',
  // HELD: the hot wallet cannot cover the payment plus the fee reserve.
  'LOW_BALANCE',
  // HELD: no healthy adapter for the product's route (production has no real fallback, Q20).
  'NO_ADAPTER',
  // FAILED + refund, proven "not sent": the recipient changed (providerRef differs) or is gone.
  'RECIPIENT_CHANGED',
  'RECIPIENT_GONE',
  // HELD after the last pre-send retry (Q22) or NEEDS_REVIEW after an unexpected provider answer.
  'ADAPTER_ERROR',
  // NEEDS_REVIEW: the chain confirmation did not arrive within TON_CONFIRM_TIMEOUT_MS.
  'CONFIRM_TIMEOUT',
  // FAILED + refund: HELD longer than HELD_MAX_AGE_MS (Q5).
  'HELD_EXPIRED',
] as const;

export const orderStatusReasonSchema = z.enum(ORDER_STATUS_REASONS);
export type OrderStatusReason = z.infer<typeof orderStatusReasonSchema>;
