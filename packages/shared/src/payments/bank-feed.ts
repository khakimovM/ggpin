// Vocabulary of the bank-feed pipeline (docs/05-PAYMENTS.md): the worker reads the bank bots'
// notifications over a Telegram user session, parses them, matches them to top-up intents and
// credits the wallet. These names are shared because the API reads what the worker writes
// (heartbeat, review kinds, alerts) and the Prisma enums must stay in step with them (a DB
// test compares both lists once the schema lands in phase 4, slice S2).
import { z } from 'zod';
import { tgOutboxJobId } from '../tg-outbox';

export const CARD_BANKS = ['HUMO', 'UZCARD'] as const;
export const CardBankSchema = z.enum(CARD_BANKS);
export type CardBank = z.infer<typeof CardBankSchema>;

/** Which bot a message came from. One bot per bank (D-37 (1)): the source determines the bank. */
export const BANK_FEED_SOURCES = ['HUMO_BOT', 'UZCARD_BOT'] as const;
export const BankFeedSourceSchema = z.enum(BANK_FEED_SOURCES);
export type BankFeedSource = z.infer<typeof BankFeedSourceSchema>;

export const BANK_OF_SOURCE: Readonly<Record<BankFeedSource, CardBank>> = Object.freeze({
  HUMO_BOT: 'HUMO',
  UZCARD_BOT: 'UZCARD',
});

// DRAINING: no new requests are handed out, but those already issued stay payable until their
// own `reservedUntil`; an ordinary retire passes through it (D-37 (6)). RETIRED comes after.
export const TOPUP_CARD_STATUSES = ['VERIFYING', 'ACTIVE', 'FULL', 'DRAINING', 'RETIRED'] as const;
export type TopupCardStatus = (typeof TOPUP_CARD_STATUSES)[number];

export const BANK_PARSE_STATUSES = ['PARSED', 'UNRECOGNIZED', 'REJECTED'] as const;
export type BankParseStatus = (typeof BANK_PARSE_STATUSES)[number];

export const BANK_DIRECTIONS = ['CREDIT', 'DEBIT'] as const;
export type BankDirection = (typeof BANK_DIRECTIONS)[number];

/** Balance-chain verdict of one message against the previous one on the same card. */
export const CHAIN_STATUSES = ['FIRST', 'OK', 'BREAK', 'NOT_APPLICABLE'] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

export const BANK_OUTCOMES = ['CREDITED', 'CARD_VERIFIED', 'DEBIT_RECORDED', 'REVIEW'] as const;
export type BankOutcome = (typeof BANK_OUTCOMES)[number];

/**
 * Why a message was NOT credited automatically and waits for the owner. Anything the worker
 * cannot prove is unambiguous ends here: an unrecognised message never becomes money.
 */
export const REVIEW_KINDS = [
  'UNRECOGNIZED',
  'REJECTED',
  'CARD_UNKNOWN',
  'CARD_RETIRED',
  'CHAIN_BREAK',
  'AUTO_CREDIT_PAUSED',
  'NO_MATCH',
  'AMBIGUOUS',
  'DUPLICATE',
  'TIME_SKEW',
  // Money for an intent the user cancelled: never credited automatically (D-37 (5)).
  'CANCELLED_LATE',
  // Crediting would push the user over a daily cap (D-37 (7)): either cap, one review kind; the
  // review records which one was exceeded.
  'DAILY_LIMIT',
  // A DEBIT equal to a recently credited payment: the bank may have taken the money back.
  'POSSIBLE_REVERSAL',
  // The matched user is blocked.
  'USER_BLOCKED',
] as const;
export const PaymentReviewKindSchema = z.enum(REVIEW_KINDS);
export type PaymentReviewKind = z.infer<typeof PaymentReviewKindSchema>;

export const PAYMENT_REVIEW_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type PaymentReviewStatus = (typeof PAYMENT_REVIEW_STATUSES)[number];

export const PAYMENT_REVIEW_RESOLUTIONS = [
  'CREDITED_USER',
  'IGNORED',
  'RETURNED_OFFLINE',
  'CHAIN_ACCEPTED',
] as const;
export type PaymentReviewResolution = (typeof PAYMENT_REVIEW_RESOLUTIONS)[number];

/**
 * Owner-alert kinds. Each one is the tail of an i18n key `alerts.bankFeed.<kind>`; the
 * review kinds map onto their alert in `REVIEW_ALERT`, the rest are operational events.
 */
export const ALERT_KINDS = [
  'unrecognized',
  'rejected',
  'edited',
  'cardUnknown',
  'cardRetired',
  'chainBreak',
  'autoCreditPaused',
  'noMatch',
  'ambiguous',
  'duplicate',
  'timeSkew',
  'cancelledLate',
  'dailyLimit',
  'possibleReversal',
  'userBlocked',
  'debit',
  'cardSilent',
  'cardDraining',
  'adminAction',
  'cardVerified',
  'cardNearLimit',
  'cardFull',
  'cardReservedHigh',
  'listenerDown',
  'sessionRevoked',
  'newAuthorization',
  'reconcileOk',
  'reconcileMismatch',
  'walletFrozen',
] as const;
export const BankFeedAlertKindSchema = z.enum(ALERT_KINDS);
export type BankFeedAlertKind = z.infer<typeof BankFeedAlertKindSchema>;

/** The alert a review of each kind raises. Record<..> makes a new kind without one a compile error. */
export const REVIEW_ALERT: Readonly<Record<PaymentReviewKind, BankFeedAlertKind>> = Object.freeze({
  UNRECOGNIZED: 'unrecognized',
  REJECTED: 'rejected',
  CARD_UNKNOWN: 'cardUnknown',
  CARD_RETIRED: 'cardRetired',
  CHAIN_BREAK: 'chainBreak',
  AUTO_CREDIT_PAUSED: 'autoCreditPaused',
  NO_MATCH: 'noMatch',
  AMBIGUOUS: 'ambiguous',
  DUPLICATE: 'duplicate',
  TIME_SKEW: 'timeSkew',
  CANCELLED_LATE: 'cancelledLate',
  DAILY_LIMIT: 'dailyLimit',
  POSSIBLE_REVERSAL: 'possibleReversal',
  USER_BLOCKED: 'userBlocked',
});

/**
 * `{placeholders}` each alert text takes, in `alerts.bankFeed.<kind>`. Alerts carry ids and
 * reason codes only: never a full card number, balance, message text or phone
 * (rules/60-security.md). A test in packages/i18n holds both locales to these lists.
 */
export const BANK_FEED_ALERT_PARAMS: Readonly<Record<BankFeedAlertKind, readonly string[]>> =
  Object.freeze({
    unrecognized: ['reviewId'],
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
    // Unpaid reservations hold over half of what the card may still receive (D-42 (1)): one per
    // card per hour. `percent` is a whole number (reserved share of the remaining limit).
    cardReservedHigh: ['bank', 'last4', 'percent'],
    listenerDown: ['minutes'],
    sessionRevoked: [],
    newAuthorization: [],
    reconcileOk: ['count', 'debits'],
    reconcileMismatch: ['count', 'debits'],
    walletFrozen: ['userId'],
  });

// ---- Tunables shared by the worker (writer) and the API (reader) ----------------------------
export const BANK_FEED_DEFAULTS = {
  POLL_SEC: 20,
  /** Older heartbeat than this means the listener is down: no new top-up intents (503). */
  HEARTBEAT_MAX_AGE_SEC: 120,
  /** Allowed gap between the time printed in the bank message and Telegram's message date. */
  BANK_TIME_SKEW_SEC: 600,
  LEADER_LOCK_TTL_SEC: 30,
  /** A request may only be matched to a message sent up to this long before it was created. */
  INTENT_CLOCK_LEEWAY_SEC: 120,
  /**
   * An active card with no CREDIT for this many DAYTIME hours raises `cardSilent` (once per
   * silent period). Night hours (Asia/Tashkent 00:00-08:00) do not count: nobody pays then.
   */
  SILENCE_ALERT_HOURS: 6,
  /** A DEBIT equal to a payment credited within this window is a `POSSIBLE_REVERSAL`. */
  REVERSAL_WINDOW_SEC: 7 * 24 * 60 * 60,
} as const;

const TASHKENT_UTC_OFFSET_MIN = 5 * 60;
const NIGHT_END_HOUR = 8;

/**
 * Minutes between two instants that fall outside the night (Asia/Tashkent 00:00-08:00, a fixed
 * UTC+5). Silence is measured in these minutes, so a quiet night never raises `cardSilent`.
 */
export function daytimeMinutesBetween(from: Date, to: Date): number {
  const first = Math.floor(from.getTime() / 60_000);
  const last = Math.floor(to.getTime() / 60_000);
  return last <= first ? 0 : daytimeMinutesBefore(last) - daytimeMinutesBefore(first);
}

// Daytime minutes from the local epoch up to `minute`, in closed form: whole local days count
// (1440 - night) each, the partial day counts what is past the night. O(1), whatever the range.
function daytimeMinutesBefore(minute: number): number {
  const local = minute + TASHKENT_UTC_OFFSET_MIN;
  const nightMinutes = NIGHT_END_HOUR * 60;
  const days = Math.floor(local / 1440);
  const intoDay = local - days * 1440;
  return days * (1440 - nightMinutes) + Math.max(0, intoDay - nightMinutes);
}

/** True when a card has been silent for at least `hours` daytime hours since its last CREDIT. */
export function isCardSilent(
  lastCreditAt: Date,
  now: Date,
  hours: number = BANK_FEED_DEFAULTS.SILENCE_ALERT_HOURS,
): boolean {
  return daytimeMinutesBetween(lastCreditAt, now) >= hours * 60;
}

// Pay-link capability token (docs/04, D-39): 32 random bytes as unpadded base64url.
export const PAY_TOKEN_LENGTH = 43;
export const PAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Header the pay page sends its token in, so it never lands in an API access log. */
export const PAY_TOKEN_HEADER = 'x-pay-token';

/** The `bank-message` job id: one BullMQ job per stored message, so a re-poll never double-enqueues. */
export function bankMessageJobId(bankMessageId: string): string {
  return tgOutboxJobId('bm', bankMessageId);
}
