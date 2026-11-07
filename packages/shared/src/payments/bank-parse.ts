// The result of parsing one bank-bot message (docs/05 §5). The parser itself is the worker's
// (apps/worker/src/bank-feed/parsers); the vocabulary is shared because the reason codes are
// stored in `BankMessage.rejectReason`, shown in owner alerts and listed in docs/05 §5.
import type { BankDirection } from './bank-feed';

/**
 * Why a bank message was not recognised. Codes only: a reason never carries a fragment of the
 * message text, an amount, a card number or a balance, because it is stored in
 * `BankMessage.rejectReason`, shown in alerts and may be logged.
 */
export const PARSE_FAILURE_REASONS = [
  'EMPTY',
  'TOO_LONG',
  // A line without a field marker that is neither the title nor a channel continuation.
  'UNEXPECTED_LINE',
  'MISSING_DIRECTION',
  'MISSING_CARD',
  'MISSING_TIME',
  'MISSING_BALANCE',
  'DUPLICATE_DIRECTION',
  'DUPLICATE_CARD',
  'DUPLICATE_CHANNEL',
  'DUPLICATE_TIME',
  'DUPLICATE_BALANCE',
  'AMOUNT_FORMAT',
  'BALANCE_FORMAT',
  // The card line is not this bank's shape (Humo "HUMOCARD *NNNN" / "*NNNN", Uzcard "***NNNN").
  'CARD_FORMAT',
  // The time line does not have one of the two known shapes.
  'DATE_FORMAT',
  // The shape is right but the moment does not exist (31.02, 24:00, year outside 2000-2099).
  'DATE',
  // The channel holds a control (\p{Cc}) or bidi-override character: never displayable safely.
  'CHANNEL_FORMAT',
  'CHANNEL_TOO_LONG',
  // A known title (or the Uzcard colour dot) contradicts the sign of the amount line.
  'DIRECTION_CONFLICT',
] as const;
export type ParseFailureReason = (typeof PARSE_FAILURE_REASONS)[number];

/** A recognised notification. Amounts are tiyin; `bankTxnAt` is the bank's time as a UTC instant. */
export interface ParsedBankMessage {
  readonly ok: true;
  readonly direction: BankDirection;
  readonly amountTiyin: bigint;
  readonly balanceAfterTiyin: bigint;
  readonly last4: string;
  readonly bankTxnAt: Date;
  readonly channel: string | null;
  /** Direction the title implies (colour dot or known title text), or null when neither. */
  readonly titleHint: BankDirection | null;
  /**
   * The first line carries a title TEXT from the bot's known list (D-43 (1)). The Uzcard colour
   * dot alone only states a direction and is not a recognised title: such a CREDIT is never
   * credited automatically.
   */
  readonly titleKnown: boolean;
}

export interface UnrecognizedBankMessage {
  readonly ok: false;
  readonly reason: ParseFailureReason;
}

export type BankParseResult = ParsedBankMessage | UnrecognizedBankMessage;

/**
 * `PaymentReview.note` codes the matcher writes (codes, never text): why a review of that kind
 * was opened when the kind alone does not say it.
 * - TITLE_UNKNOWN (kind UNRECOGNIZED, D-43): a fully parsed CREDIT whose first line has no
 *   known title text (`titleKnown === false`; a colour dot is not a title) matched exactly one
 *   open request. It is never credited
 *   automatically; the owner decides.
 * - REPARSE_MISMATCH / TEXT_MISSING (kind UNRECOGNIZED): the title is read by parsing the stored
 *   raw text again; a result that differs from the stored fields, or a purged text, is an
 *   anomaly and is never credited.
 * - PREDECESSOR_PENDING (kind CHAIN_BREAK): an earlier message of the card was still not
 *   processed after every retry, so the balance chain could not be checked.
 * - DAILY_LIMIT / NEW_ACCOUNT_DAILY_LIMIT (kind DAILY_LIMIT): which 24 h cap would be exceeded.
 * - AMOUNT_REALLOCATED (kind AMBIGUOUS): the money matched an EXPIRED request late, but its
 *   amount was already handed to a newer request on the card; crediting would make the two
 *   reservations overlap, so the owner decides whose money it is.
 * - SENDER_MISMATCH / TEXT_HASH_MISMATCH (kind UNRECOGNIZED): the stored row is not from the
 *   pinned bot of its source, or its raw text no longer hashes to textSha256. Integrity
 *   anomalies: never credited, the card's auto-credit is paused.
 * - PROCESSING_FAILED (kind UNRECOGNIZED): every attempt of the job ended in an unexpected
 *   error; the matcher fails closed (review, card paused, alert) instead of leaving the money
 *   silently unprocessed.
 */
export const REVIEW_NOTE_CODES = [
  'TITLE_UNKNOWN',
  'REPARSE_MISMATCH',
  'TEXT_MISSING',
  'PREDECESSOR_PENDING',
  'DAILY_LIMIT',
  'NEW_ACCOUNT_DAILY_LIMIT',
  'AMOUNT_REALLOCATED',
  'SENDER_MISMATCH',
  'TEXT_HASH_MISMATCH',
  'PROCESSING_FAILED',
] as const;
export type ReviewNoteCode = (typeof REVIEW_NOTE_CODES)[number];
