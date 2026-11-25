import { z } from 'zod';

// Phase 5 S9 (D-64 (10)): the order reconciler's two knobs, owner-approved.
// - ORDER_RECONCILE_EVERY_MS: how often the `reconcile:orders` tick runs (10 minutes). At least a
//   minute: every tick reads the chain for the unresolved transfer and walks the review queue.
// - HELD_MAX_AGE_MS: how long a HELD order may wait, from its latest HELD event by the database
//   clock, before it is failed and refunded (6 hours, D-56 (4)). At least an hour, so a hold the
//   owner is looking at is not refunded under their hands.
// Both have a ceiling too (S9c review CR2, audit L-3): a typo of a few zeros must not switch the
// reconciler off for weeks or keep held money from its owner indefinitely. At most an hour between
// ticks, at most 7 days on hold; both are safe integers well inside a timer's range.

export const ORDER_RECONCILE_EVERY_DEFAULT_MS = 600_000;
export const ORDER_RECONCILE_EVERY_MIN_MS = 60_000;
export const HELD_MAX_AGE_DEFAULT_MS = 21_600_000;
export const HELD_MAX_AGE_MIN_MS = 3_600_000;
export const ORDER_RECONCILE_EVERY_MAX_MS = 3_600_000;
export const HELD_MAX_AGE_MAX_MS = 604_800_000;

const SAFE = { message: 'must be a safe integer' } as const;

export const workerOrderReconcileShape = {
  ORDER_RECONCILE_EVERY_MS: z.coerce
    .number()
    .int()
    .min(ORDER_RECONCILE_EVERY_MIN_MS)
    .max(ORDER_RECONCILE_EVERY_MAX_MS)
    .refine(Number.isSafeInteger, SAFE)
    .default(ORDER_RECONCILE_EVERY_DEFAULT_MS),
  HELD_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(HELD_MAX_AGE_MIN_MS)
    .max(HELD_MAX_AGE_MAX_MS)
    .refine(Number.isSafeInteger, SAFE)
    .default(HELD_MAX_AGE_DEFAULT_MS),
} as const;
