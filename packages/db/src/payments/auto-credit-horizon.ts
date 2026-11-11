/**
 * How long after a bank message was stored the worker may still credit it automatically: the
 * orphan re-queue (worker `ORPHAN_LOOKBACK_MS`) gives an undecided message its job back for this
 * long. A positive wallet:adjust looks back as far for automatic top-ups (api
 * `RECENT_AUTO_TOPUP_WINDOW_MS`, S9F-L2). Both are counted back from NOW (the adjustment by
 * `Payment.confirmedAt`), not from the transfer's time: a credit the re-queue makes late is
 * confirmed now and so always inside the window, but a top-up credited more than 7 days ago is
 * not shown (runbook: check the payment history by hand for an older transfer, docs/05 §4).
 * ONE number for both: the worker and the API import it from here.
 */
export const AUTO_CREDIT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
