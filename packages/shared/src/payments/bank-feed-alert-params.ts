import type { BankFeedAlertKind } from './bank-feed';

/**
 * `{placeholders}` each alert text takes, in `alerts.bankFeed.<kind>`. Alerts carry ids and
 * reason codes only: never a full card number, balance, message text or phone
 * (rules/60-security.md). A test in packages/i18n holds both locales to these lists.
 */
export const BANK_FEED_ALERT_PARAMS: Readonly<Record<BankFeedAlertKind, readonly string[]>> =
  Object.freeze({
    unrecognized: ['reviewId'],
    // D-43 (1): an exact match without a known title, never credited automatically.
    titleUnknown: ['reviewId', 'bank', 'last4', 'amount'],
    // Both pause the card's auto-credit (docs/05 §6) and say so. integrityAnomaly is a security
    // signal; reason = the note code (SENDER_MISMATCH may also be a misconfigured bot id).
    integrityAnomaly: ['reviewId', 'bank', 'last4', 'reason'],
    // B2: a message of another chat reached the source; NOT stored (refId = <source>_<epoch hour>).
    foreignChat: ['bank'],
    processingFailed: ['reviewId', 'bank', 'last4'],
    // A late payment whose amount was meanwhile given to a newer request (docs/05 §6 step 7).
    amountReallocated: ['reviewId', 'bank', 'last4', 'amount'],
    // D-47: stored late (re-scan or catch-up) for a request no longer PENDING: the owner decides.
    lateStored: ['reviewId', 'bank', 'last4', 'amount'],
    // R1: the owner credited the user by hand after the request; the owner decides (no balance).
    manualCreditSeen: ['reviewId', 'bank', 'last4', 'amount'],
    rejected: ['reviewId', 'reason'],
    edited: ['messageId'],
    cardUnknown: ['reviewId'],
    cardRetired: ['reviewId', 'last4'],
    chainBreak: ['reviewId', 'last4'],
    autoCreditPaused: ['reviewId', 'last4'],
    noMatch: ['reviewId', 'amount'],
    ambiguous: ['reviewId', 'amount'],
    duplicate: ['reviewId', 'amount'],
    timeSkew: ['reviewId'],
    cancelledLate: ['reviewId', 'amount'],
    dailyLimit: ['reviewId', 'amount', 'limit'],
    possibleReversal: ['reviewId', 'last4', 'amount'],
    userBlocked: ['reviewId', 'amount'],
    // Every DEBIT on a receiving card is reported (D-37 (8)): money leaving it is never routine.
    debit: ['last4', 'amount'],
    // No CREDIT on an active card for `hours`: a silent listener or bot looks the same as no sales.
    cardSilent: ['bank', 'last4', 'hours'],
    cardDraining: ['bank', 'last4'],
    // Every money or card operation by the owner CLI (D-37 (9)).
    adminAction: ['action', 'ref'],
    cardVerified: ['bank', 'last4'],
    cardNearLimit: ['bank', 'last4', 'percent'],
    cardFull: ['bank', 'last4'],
    // Unpaid reservations hold over half of what the card may still receive (D-42 (1)), hourly.
    cardReservedHigh: ['bank', 'last4', 'percent'],
    // D-42 residual risk: a payment after `expiresAt + TOPUP_CAPACITY_HOLD_SEC` left the card over
    // its receive limit. One per payment (refId = Payment.id); `amount` = that payment.
    lateOverLimit: ['bank', 'last4', 'amount'],
    listenerDown: ['minutes'],
    sessionRevoked: [],
    newAuthorization: [],
    // The day's reconciliation (refId = yyyymmdd): count = checked messages (ok) or mismatches;
    // history = the 48 h re-scan; details = non-zero mismatch codes. Failed: no DB read at all.
    reconcileOk: ['count', 'debits', 'openReviews', 'history'],
    reconcileMismatch: ['count', 'debits', 'openReviews', 'history', 'details'],
    reconcileFailed: ['day'],
    walletFrozen: ['userId'],
    // The card-limit check of a received CREDIT failed every attempt (refId = BankMessage.id).
    limitCheckFailed: ['messageId', 'bank', 'last4'],
    // refId = BankMessage.id, no database read. Stuck: the last attempt failed with no decision
    // stored (re-queued later). EffectsFailed: decision stored, post-commit effects failed (never).
    messageStuck: ['messageId'],
    effectsFailed: ['messageId'],
  });
