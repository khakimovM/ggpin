import type { BankDirection } from '@repo/shared';
import { titleColor } from './markers';

/**
 * A first-line title whose meaning is known. Two uses with two rules: a line that merely STARTS
 * with it (prefix, `titleHints`) can only REFUSE a message (DIRECTION_CONFLICT); a line counts as
 * a KNOWN title for auto-credit only when it IS the title (`exactTitleDirections`, D-43 (1)).
 */
export interface KnownTitle {
  readonly text: string;
  readonly direction: BankDirection;
}

// Apostrophe look-alikes (U+2018, U+2019, U+02B9, U+02BB, U+02BC, U+2032, U+FF07, backtick,
// U+00B4) all compare as the ASCII one the Humo bot prints.
const APOSTROPHES = /[\u{2018}\u{2019}\u{02B9}\u{02BB}\u{02BC}\u{2032}\u{FF07}`\u{00B4}]/gu;
// Zero-width space and ideographic space count as a word break.
const SPACE_LIKE = /[\u{200B}\u{3000}]/gu;
// Soft hyphen, joiners, word joiner and BOM are invisible inside a word: dropped. An
// alternation, not a character class: a ZWJ inside a class reads as a joined emoji sequence
// (no-misleading-character-class).
const INVISIBLE = /\u{00AD}|\u{200C}|\u{200D}|\u{2060}|\u{FEFF}/gu;
// Hyphen and dash look-alikes (U+2010..U+2015, minus sign U+2212) compare as ASCII "-"
// ("E-Com oplata").
const DASHES = /[\u{2010}-\u{2015}\u{2212}]/gu;
// The title's leading emoji, quotes, punctuation and spaces.
const LEADING_NON_LETTERS = /^[^\p{L}]+/u;
const WORD_CHARACTER = /^[\p{L}\p{N}]/u;
// What may follow an exact title: punctuation, emoji, spaces (nothing with a letter or digit).
const TRAILING_NON_WORD = /[^\p{L}\p{N}]+$/u;

function canonical(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(SPACE_LIKE, ' ')
    .replace(APOSTROPHES, "'")
    .replace(DASHES, '-')
    .replace(LEADING_NON_LETTERS, '')
    .toLowerCase();
}

/**
 * Directions of the known titles the line IS, the only rule that makes a title "known" for
 * auto-credit (D-43 (1)): an exact match of the canonical text, a prefix is not enough. Allowed
 * around it: a leading colour dot / emoji / quotes (dropped by `canonical`) and trailing
 * punctuation or emoji. "To'ldirish TEST", "Пополнение наличными" or "... (bekor qilindi)" are
 * NOT known: if the bank changes its wording, the message goes to review instead of being
 * credited silently.
 */
export function exactTitleDirections(line: string, titles: readonly KnownTitle[]): BankDirection[] {
  const text = canonical(line).replace(TRAILING_NON_WORD, '');
  return titles
    .filter((title) => canonical(title.text).replace(TRAILING_NON_WORD, '') === text)
    .map((title) => title.direction);
}

/** Directions of the known title texts the line starts with (prefix rule, refusal only). */
function prefixTitleDirections(line: string, titles: readonly KnownTitle[]): BankDirection[] {
  const text = canonical(line);
  return titles
    .filter((title) => {
      const key = canonical(title.text);
      return text.startsWith(key) && !WORD_CHARACTER.test(text.slice(key.length));
    })
    .map((title) => title.direction);
}

/**
 * Every direction the title line implies: its colour dot and any known title it starts with.
 * The key must end at a word boundary (`^key(?![\p{L}\p{N}])`): "To'lov:", "To'lov!" or
 * "To'lov TEST" match, "To'lovlar" does not. An unknown title implies nothing. A match can only
 * refuse a message, so matching generously is the safe direction.
 */
export function titleHints(line: string, titles: readonly KnownTitle[]): BankDirection[] {
  const color = titleColor(line);
  return [...(color === null ? [] : [color]), ...prefixTitleDirections(line, titles)];
}
