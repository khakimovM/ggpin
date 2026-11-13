// Settings of the `fulfill-order` queue that more than one package must agree on. They live here,
// next to the other fulfillment constants, and not in the review-proof module: the proof does not
// own the worker's lock.

/**
 * The BullMQ `lockDuration` of the `fulfill-order` worker (plan 6.4 step 7: longer than the
 * 3-minute confirmation wait). S4 configures the worker with this constant.
 *
 * BullMQ renews the lock for as long as the worker process is alive, so the lock being "held" is
 * not a bound on how long a job runs: a live worker keeps it past `lockDuration`. The age rule of
 * `resolveNeedsReview` (an operator may not call a transfer-less SENDING attempt "never sent"
 * before `lockDuration + TON_NOT_SENT_MARGIN_MS` have passed since it was created) is therefore
 * only a HEURISTIC that keeps an operator away from a job that is probably still running. The real
 * barrier is in the database (migration 10): a new attempt is born only for an order that is
 * PROCESSING; a new transfer only for an attempt that is SENDING of an order that is PROCESSING; and
 * `externalRef` is written only while the attempt itself is SENDING, SENT or UNKNOWN (the guard looks
 * at the attempt's status, not at the order's). A worker that outlives the operator's decision finds
 * the attempt FAILED and the order refunded, so it cannot sign (docs/06 "S1 to'lov yo'li invariantlari").
 */
export const FULFILL_ORDER_LOCK_DURATION_MS = 4 * 60_000;
