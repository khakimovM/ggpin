// Write side of `/api/v1/admin/orders/*` (plan S10, D-63 (3), (4), (8)). DRAFT until 9-B: the
// services are phase 5's (`OrderRetryService`, `OrderReviewService`) plus the new cancel /
// fail-and-refund / refund. Every state change goes through order-state.ts; a refund is a REFUND
// ledger entry in the same transaction (rules/40).
import { z } from 'zod';
import { TiyinStringSchema } from '../money-schemas';
import {
  AdminReasonSchema,
  PositiveTiyinStringSchema,
  adminActionResultShape,
  adminConfirmationShape,
} from './admin-common-schemas';
import { AdminOrderRowSchema, AdminTxHashSchema } from './admin-orders-schemas';
import { AdminResolveProofSchema } from './admin-resolve-proof-schemas';

/** `POST /admin/orders/:id/retry` — HELD → QUEUED. */
export const AdminOrderRetryBodySchema = z.strictObject({ reason: AdminReasonSchema });
export type AdminOrderRetryBody = z.infer<typeof AdminOrderRetryBodySchema>;

/**
 * `cancel` (PAID / QUEUED / HELD → CANCELLED → REFUNDED) and `fail-and-refund`
 * (HELD → FAILED → REFUNDED): always the WHOLE total. OPERATOR only while the total is within
 * `ADMIN_OPERATOR_REFUND_MAX_TIYIN`; above `ADMIN_CONFIRM_THRESHOLD_TIYIN` the total is re-typed
 * (`confirmAmountTiyin`) and the code given.
 */
export const AdminOrderCancelBodySchema = z.strictObject({
  reason: AdminReasonSchema,
  ...adminConfirmationShape,
});
export type AdminOrderCancelBody = z.infer<typeof AdminOrderCancelBodySchema>;

export const AdminOrderFailAndRefundBodySchema = AdminOrderCancelBodySchema;
export type AdminOrderFailAndRefundBody = AdminOrderCancelBody;

/**
 * `POST /admin/orders/:id/resolve` (OWNER) — NEEDS_REVIEW → DELIVERED, or → FAILED + REFUND.
 * `deliveredOutsideSystem` is the CLI's `--delivered-outside-system` (I-8): required exactly when
 * a MANUAL delivery closes an attempt whose TON never left the wallet. The code is needed for the
 * proof kinds of phase 5 `proofNeedsOwnerOtp` (MANUAL, TON_NOT_DEBITED, TON_BOUNCED) and above
 * the threshold.
 */
export const AdminOrderResolveBodySchema = z.strictObject({
  outcome: z.enum(['DELIVERED', 'FAILED']),
  proof: AdminResolveProofSchema,
  deliveredOutsideSystem: z.boolean().default(false),
  reason: AdminReasonSchema,
  ...adminConfirmationShape,
});
export type AdminOrderResolveBody = z.infer<typeof AdminOrderResolveBodySchema>;

const refundShape = {
  /** The late bounce that justifies the refund, stored in the audit proof, never reused (I-7). */
  returnTxHash: AdminTxHashSchema.optional(),
  reason: AdminReasonSchema,
  ...adminConfirmationShape,
};

/**
 * `POST /admin/orders/:id/refund` (OWNER) — a DELIVERED order. `mode: FULL`: the whole remaining
 * total, DELIVERED → REFUNDED (`REFUND`, ref `ORDER/<orderId>`), no `amountTiyin`. `mode:
 * PARTIAL`: exactly `amountTiyin`, the order stays DELIVERED (`REFUND`, ref
 * `ADMIN_ACTION/<auditId>`). The mode is explicit and bound by the code, so a partial refund equal
 * to the remainder can never be confused with a full one (review M-3 / N3).
 */
export const AdminOrderRefundBodySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('FULL'), ...refundShape }),
  z.strictObject({
    mode: z.literal('PARTIAL'),
    amountTiyin: PositiveTiyinStringSchema,
    ...refundShape,
  }),
]);
export type AdminOrderRefundBody = z.infer<typeof AdminOrderRefundBodySchema>;

/** Every order action answers with the order after it (`refundTiyin`: money returned now). */
export const AdminOrderActionResponseSchema = z.strictObject({
  order: AdminOrderRowSchema,
  refundTiyin: TiyinStringSchema.nullable(),
  ...adminActionResultShape,
});
export type AdminOrderActionResponse = z.infer<typeof AdminOrderActionResponseSchema>;
