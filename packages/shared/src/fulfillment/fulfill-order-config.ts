// Settings of the `fulfill-order` queue that more than one package must agree on. They live here,
// next to the other fulfillment constants, and not in the review-proof module: the proof does not
// own the worker's lock.

/**
 * The BullMQ `lockDuration` of the `fulfill-order` worker. S4 configures the worker with it.
 *
 * It is NOT a bound on how long a job runs, and it need not outlast the TON confirmation wait
 * (TON_CONFIRM_TIMEOUT_MS: 5 minutes by default, up to 10): BullMQ renews the lock every
 * lockDuration / 2 for as long as the worker's event loop runs, and the wait only sleeps between
 * looks. The lock lapses only when the worker dies, its event loop stops for too long (a crash, a
 * VM or WSL sleep) or it loses Redis while the lock runs out; BullMQ then delivers the job again as
 * stalled. That second delivery
 * is safe on its own, not because of this number: the TON sender first looks for the attempt's
 * transfer (`findByAttempt`) and then only follows it, never signs again; a transfer-less attempt
 * is signed only under the wallet lock, with an `externalRef` compare-and-set and the database
 * guards of migration 10 (one unresolved transfer per wallet; a new attempt only for a PROCESSING
 * order, a new transfer only for a SENDING attempt of a PROCESSING order; `externalRef` written
 * only while the attempt is SENDING, SENT or UNKNOWN). What the number does decide:
 * - liveness: the job of a dead worker waits between lockDuration / 2 and lockDuration (the lock was
 *   last renewed at most lockDuration / 2 before the death) before it runs again. Even the shortest
 *   wait covers the TON wallet lease (DEFAULT_LOCK_TTL_MS, 120 s, renewed on every poll), so the
 *   dead worker's lease has lapsed by then and does not turn the new delivery away as WALLET_BUSY
 *   (fulfill-order-lock.spec.ts);
 * - the age rule of `resolveNeedsReview`: an operator may not call a transfer-less SENDING attempt
 *   "never sent" (MANUAL) before `lockDuration + TON_NOT_SENT_MARGIN_MS` have passed since it was
 *   created. Only a HEURISTIC that keeps an operator away from a job that is probably running: it
 *   covers just the short step from the attempt's SENDING commit to its TonTransfer (wallet lock,
 *   one look at a blocking transfer, one chain snapshot, signing; nothing in it waits). The
 *   confirmation wait comes after the transfer exists, and a transfer that is not EXPIRED refuses
 *   MANUAL -> FAILED at any age (LIVE_PAYOUT), so a longer TON_CONFIRM_TIMEOUT_MS does not touch
 *   this rule. A worker that outlives the operator's decision finds the attempt FAILED and the
 *   order refunded, so it cannot sign (docs/06 "S1 to'lov yo'li invariantlari").
 */
export const FULFILL_ORDER_LOCK_DURATION_MS = 4 * 60_000;
