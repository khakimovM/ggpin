import type { BankDirection } from '@repo/shared';
import { titleColor } from './markers';

/** A first-line title whose meaning is known. Only ever used to REFUSE a message, never to accept one. */
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
 * Every direction the title line implies: its colour dot and any known title it starts with.
 * The key must end at a word boundary (`^key(?![\p{L}\p{N}])`): "To'lov:", "To'lov!" or
 * "To'lov TEST" match, "To'lovlar" does not. An unknown title implies nothing. A match can only
 * refuse a message, so matching generously is the safe direction.
 */
export function titleHints(line: string, titles: readonly KnownTitle[]): BankDirection[] {
  const hints: BankDirection[] = [];
  const color = titleColor(line);
  if (color !== null) hints.push(color);
  const text = canonical(line);
  for (const title of titles) {
    const key = canonical(title.text);
    if (text.startsWith(key) && !WORD_CHARACTER.test(text.slice(key.length))) {
      hints.push(title.direction);
    }
  }
  return hints;
}
