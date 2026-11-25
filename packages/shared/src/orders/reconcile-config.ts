// Fixed tuning of the order reconciler (phase 5 S9, D-64 (10)). Constants, not env: the owner
// approved these numbers, and the two values that are env (`ORDER_RECONCILE_EVERY_MS`,
// `HELD_MAX_AGE_MS`) live in the worker's config. Every time window is measured on the DATABASE
// clock by the reconciler, never on a process clock.
import type { OrderStatusReason } from './order-status-reason';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A PAID, QUEUED or PROCESSING order whose state has not changed for this long and that has no
 * fulfill-order job is queued again through the enqueuer (D-64 (3)).
 */
export const ORDER_STALE_AFTER_MS = 10 * MINUTE_MS;

/** How many times the reconciler may release one HELD order by itself (D-64 (4)). */
export const HELD_AUTO_RELEASE_MAX = 3;

/**
 * The HELD reasons the reconciler may release by itself (D-64 (4)): a missing route, a price above
 * the ceiling, the TON per-order / daily limits and a low hot-wallet balance, each only once the
 * cause is gone. Its own list on purpose, not derived from ATTEMPT_HOLD_ERRORS: a new hold error
 * must never become releasable without an owner decision. Typed against the stored reasons, so a
 * misspelled literal fails the typecheck. For the worker reconciler only (S9e SA N-4): the API never
 * imports it (apps/api releasable-held-boundary.spec.ts), and in the worker only the release
 * policy does (order-reconcile-static-db.spec.ts).
 */
export const RELEASABLE_HELD_REASONS = [
  'NO_ADAPTER',
  'PRICE_ABOVE_MAX',
  'LIMIT_PER_ORDER',
  'LIMIT_DAILY',
  'LOW_BALANCE',
] as const satisfies readonly OrderStatusReason[];
export type ReleasableHeldReason = (typeof RELEASABLE_HELD_REASONS)[number];

/**
 * HELD and NEEDS_REVIEW notices are sent again (same stable job ids) only while the order entered
 * that state less than this long ago, so a notice is never repeated after its dedupe expired
 * (D-64 (3), Q-19).
 */
export const REVIEW_NOTICE_RESEND_WINDOW_MS = 24 * HOUR_MS;

/**
 * I-3 (D-64 (9)): the effects of an audit row are restored only for rows younger than this...
 */
export const AUDIT_EFFECTS_WINDOW_MS = 24 * HOUR_MS;

/** ...and older than this, so the API that wrote the row has had time to queue them itself. */
export const AUDIT_EFFECTS_MIN_AGE_MS = 2 * MINUTE_MS;

/**
 * A transfer counted as not sent (EXPIRED, CONSUMED_UNMATCHED) and a CONFIRMED one (late bounce)
 * is watched on the chain for this long after it was created (D-64 (7), Q-12).
 */
export const LATE_WATCH_WINDOW_MS = 72 * HOUR_MS;

/**
 * `lock:order:{id}` held while the order's state has not moved for this long (and no job is
 * active): the owner gets the `needsReview` alert with refId `<orderId>_lock_<hour>`. The key is never
 * deleted (D-64 (3), Q-17).
 */
export const ORDER_LOCK_STUCK_AFTER_MS = 30 * MINUTE_MS;

/** At most this many orders (or transfers, or audit rows) per reconciler step and tick. */
export const RECONCILE_BATCH_LIMIT = 100;

/**
 * The `reason` of a proof the reconciler builds itself (TON_TX, TON_NOT_SENT): kept in the audit
 * row, read by the owner. Technical English, like every other system-written audit text.
 */
export const RECONCILER_PROOF_REASON =
  'order reconciler: resolved from chain evidence stored by the TON module';
