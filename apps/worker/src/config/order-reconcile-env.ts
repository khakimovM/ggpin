import { z } from 'zod';

// Phase 5 S9 (D-64 (10)): the order reconciler's two knobs, owner-approved.
// - ORDER_RECONCILE_EVERY_MS: how often the `reconcile:orders` tick runs (10 minutes). At least a
//   minute: every tick reads the chain for the unresolved transfer and walks the review queue.
// - HELD_MAX_AGE_MS: how long a HELD order may wait, from its latest HELD event by the database
//   clock, before it is failed and refunded (6 hours, D-56 (4)). At least an hour, so a hold the
//   owner is looking at is not refunded under their hands.

export const ORDER_RECONCILE_EVERY_DEFAULT_MS = 600_000;
export const ORDER_RECONCILE_EVERY_MIN_MS = 60_000;
export const HELD_MAX_AGE_DEFAULT_MS = 21_600_000;
export const HELD_MAX_AGE_MIN_MS = 3_600_000;

export const workerOrderReconcileShape = {
  ORDER_RECONCILE_EVERY_MS: z.coerce
    .number()
    .int()
    .min(ORDER_RECONCILE_EVERY_MIN_MS)
    .default(ORDER_RECONCILE_EVERY_DEFAULT_MS),
  HELD_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(HELD_MAX_AGE_MIN_MS)
    .default(HELD_MAX_AGE_DEFAULT_MS),
} as const;
