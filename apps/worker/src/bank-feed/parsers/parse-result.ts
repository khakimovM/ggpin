import type { BankDirection } from '@repo/shared';

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
  /** Direction the title implies, or null when the title is absent or not a known one. */
  readonly titleHint: BankDirection | null;
}

export interface UnrecognizedBankMessage {
  readonly ok: false;
  readonly reason: ParseFailureReason;
}

export type BankParseResult = ParsedBankMessage | UnrecognizedBankMessage;

export function unrecognized(reason: ParseFailureReason): UnrecognizedBankMessage {
  return { ok: false, reason };
}
