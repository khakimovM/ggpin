import { MoneyError, parseSignedMajor } from '@repo/shared';

// What the admin types in a so'm field, as the tiyin string the API takes. The only parser is the
// shared money module (BigInt): no Number, no parseFloat, no `* 100` in the browser.

export type AmountIssue = 'empty' | 'invalid' | 'zero' | 'tooLarge';

export type AmountParse = { ok: true; tiyin: string } | { ok: false; issue: AmountIssue };

export interface AmountRules {
  /** A signed delta (wallet adjustment); otherwise a leading minus is refused. */
  signed?: boolean;
  /** The largest magnitude in tiyin (inclusive). */
  maxTiyin: bigint;
}

// Group separators people type or paste: space, no-break space, narrow no-break and thin space.
const SPACES = /[\s\u00A0\u202F\u2009]/g;
// "1.500" / "1,500" is 1 500 so'm to some and 1,50 to others (CR-3): exactly three digits after
// the one decimal mark is refused instead of guessed. Thousands are grouped with spaces only.
// The shared parser also refuses more than two decimals; this regex makes that refusal explicit
// (`invalid`) and independent of the parser's message.
const THREE_DECIMALS = /^-?\d*[.,]\d{3}$/;

/**
 * "150 000" → "15000000", "-1 500,50" → "-150050". A comma or a dot is the decimal mark, at most
 * two decimals (tiyin); exactly three is ambiguous and refused; "−" counts as a minus. Zero and
 * anything above `maxTiyin` are refused.
 */
export function parseAmountInput(raw: string, rules: AmountRules): AmountParse {
  const bare = raw.replace(SPACES, '').replace(/−/g, '-');
  if (bare === '' || bare === '-') return { ok: false, issue: 'empty' };
  if (THREE_DECIMALS.test(bare)) return { ok: false, issue: 'invalid' };
  const text = bare.replace(',', '.');
  if (!rules.signed && text.startsWith('-')) return { ok: false, issue: 'invalid' };
  let tiyin: bigint;
  try {
    tiyin = parseSignedMajor('UZS', text);
  } catch (error) {
    if (error instanceof MoneyError) return { ok: false, issue: 'invalid' };
    throw error;
  }
  if (tiyin === 0n) return { ok: false, issue: 'zero' };
  const magnitude = tiyin < 0n ? -tiyin : tiyin;
  if (magnitude > rules.maxTiyin) return { ok: false, issue: 'tooLarge' };
  return { ok: true, tiyin: tiyin.toString() };
}

/** The tiyin string of a field, or null while it is not a valid amount. */
export function amountOrNull(raw: string, rules: AmountRules): string | null {
  const parsed = parseAmountInput(raw, rules);
  return parsed.ok ? parsed.tiyin : null;
}
