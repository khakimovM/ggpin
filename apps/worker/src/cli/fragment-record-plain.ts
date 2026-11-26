import { PLACEHOLDER_KINDS } from '../adapters/fragment/sanitizer-rules';

// Rule (b) of strict text (P6-S0a fix rounds 1-2; CR N1-N3, SA R1/R2/R4): is a sanitized string
// plain? Every token holding a letter must be a word of the small lists below; anything else (a
// surname, a patronymic, `Ro'za`, `Li`, `Q0s1m0va`, `王伟`, an encoded or zero-width-split name, a
// made-up placeholder) makes the string `<REDACTED:secret>`.

/** The plain words a Fragment message may hold. Small and fixed on purpose (pinned by a test). */
export const PLAIN_WORDS: ReadonlySet<string> = new Set([
  'already',
  'has',
  'have',
  'telegram',
  'premium',
  'stars',
  'account',
  'user',
  'users',
  'not',
  'found',
  'gift',
  'subscription',
  'this',
  'the',
  'and',
  'for',
  'cannot',
  'can',
  'you',
  'with',
  'month',
  'months',
  'invalid',
  'recipient',
  'username',
  'error',
]);

/** One- and two-letter English words allowed (CR N2); any other short letter token is not. */
export const SHORT_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'is',
  'in',
  'of',
  'to',
  'on',
  'no',
  'or',
  'by',
  'at',
  'it',
  'ok',
]);

/** Apostrophe forms: letters inside a word (`Ro'za`, `O‘g‘il` are one word each). */
const APOSTROPHES = "'`´‘’ʹʻʼꞌ";
const EDGE_APOSTROPHES = new RegExp(`^[${APOSTROPHES}]+|[${APOSTROPHES}]+$`, 'gu');
const TOKEN = new RegExp(`[\\p{L}\\p{M}\\p{N}${APOSTROPHES}]+`, 'gu');
/** Only the closed placeholder list (and the strict key placeholder) counts as redacted. */
const PLACEHOLDERS = new RegExp(`<REDACTED:(?:${PLACEHOLDER_KINDS.join('|')}|key#\\d+)>`, 'g');
/** An encoded character: the text may hide a name, so it is never plain (SA R1, CR N1). */
const ENCODED = /&#x?[0-9a-f]+;?|&[a-z][a-z0-9]*;|%[0-9a-f]{2}|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i;
/** 5+ digits, also split by spaces, dots, commas or dashes (SA R2): a third person's number. */
const DIGIT_RUN = /\d(?:[\s.,-]?\d){4,}/;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** NFC with the invisible format characters (zero-width and the like) removed. */
export function canonical(text: string): string {
  return text.normalize('NFC').replace(/\p{Cf}/gu, '');
}

function plainToken(raw: string): boolean {
  const token = raw.replace(EDGE_APOSTROPHES, '');
  if (!/\p{L}/u.test(token)) return true; // digits only: judged by DIGIT_RUN
  if (/\p{N}/u.test(token) || CJK.test(token)) return false;
  const lower = token.toLowerCase();
  return PLAIN_WORDS.has(lower) || SHORT_WORDS.has(lower);
}

/** True when the (already sanitized) string may be staged as it is. */
export function plainText(text: string, digits: boolean): boolean {
  const rest = canonical(text).replace(PLACEHOLDERS, ' ');
  if (ENCODED.test(rest)) return false;
  if (digits && DIGIT_RUN.test(rest)) return false;
  for (const m of rest.matchAll(TOKEN)) if (!plainToken(m[0])) return false;
  return true;
}

/** Name words: every token holding a letter or digit, canonical, lower case, apostrophes one. */
export function nameWordSet(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    for (const m of canonical(name).toLowerCase().matchAll(TOKEN)) {
      const word = m[0]
        .replace(EDGE_APOSTROPHES, '')
        .replace(new RegExp(`[${APOSTROPHES}]`, 'gu'), "'");
      if (/[\p{L}\p{N}]/u.test(word)) out.add(word);
    }
  }
  return out;
}
