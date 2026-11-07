import type { BankDirection, BankFeedSource, ReviewNoteCode } from '@repo/shared';
import { parseBankMessage } from './parsers/parse-bank-message';

/** The parsed fields stored on a `BankMessage` row. */
export interface StoredParse {
  readonly source: BankFeedSource;
  readonly direction: BankDirection;
  readonly amountTiyin: bigint;
  readonly balanceAfterTiyin: bigint;
  readonly last4: string;
  readonly bankTxnAt: Date;
}

export type TitleVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly note: Extract<ReviewNoteCode, 'TITLE_UNKNOWN' | 'REPARSE_MISMATCH' | 'TEXT_MISSING'>;
    };

/**
 * D-43 (1): a CREDIT is credited automatically only when its first line carries a KNOWN title
 * text that agrees with the amount sign (a colour dot is not a title). `BankMessage` does not store the title hint, so it is read by parsing
 * the stored raw text again (the parser is pure and deterministic). The re-parse must reproduce
 * the stored fields exactly; a different result (a parser change, a tampered row) or a purged
 * text is an anomaly, and none of the three is ever credited without the owner.
 */
export function checkCreditTitle(stored: StoredParse, rawText: string | null): TitleVerdict {
  if (rawText === null) return { ok: false, note: 'TEXT_MISSING' };
  const parsed = parseBankMessage(stored.source, rawText);
  if (
    !parsed.ok ||
    parsed.direction !== stored.direction ||
    parsed.amountTiyin !== stored.amountTiyin ||
    parsed.balanceAfterTiyin !== stored.balanceAfterTiyin ||
    parsed.last4 !== stored.last4 ||
    parsed.bankTxnAt.getTime() !== stored.bankTxnAt.getTime()
  ) {
    return { ok: false, note: 'REPARSE_MISMATCH' };
  }
  // A known title TEXT is required (D-43 (1)); the Uzcard colour dot alone states a direction,
  // it is not a recognised title. The parser already refuses a known title that contradicts the
  // sign (DIRECTION_CONFLICT), so a known title here always agrees with the direction.
  return parsed.titleKnown ? { ok: true } : { ok: false, note: 'TITLE_UNKNOWN' };
}
