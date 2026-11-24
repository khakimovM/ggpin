// Promo code text (phase 10, D-72 (9)): what a person types for a bonus code or a discount code is
// reduced to ONE canonical form before it is hashed (bonus codes, stored only as an HMAC) or looked
// up (discount codes). Two spellings of the same code must give the same form, or a code typed
// from a screenshot, with a dash or in lower case would read as unknown.

/** Shortest and longest canonical code, checked AFTER normalisation. */
export const PROMO_CODE_MIN_LENGTH = 4;
export const PROMO_CODE_MAX_LENGTH = 32;
/** A hand-picked (vanity) bonus code like `GG5000` is at least this long (D-72 (9)). */
export const VANITY_CODE_MIN_LENGTH = 6;

/**
 * The alphabet of generated codes: Crockford base32 (which already leaves out I, L, O and U)
 * without 0 and 1, so no generated code holds a character that reads as another one.
 * A vanity code may still use any Latin capital and digit (`GG5000`).
 */
export const PROMO_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generated discount codes: `GG` + 8 characters of the alphabet, `GG7KQ2MXP4` (shown grouped as
 * `GG-7KQ2-MXP4`). 30^8 ≈ 6.6 × 10^11, about 39 bits: a code is also bound to its owner, so a
 * guessed code of another user is useless (`CODE_INVALID`).
 */
export const DISCOUNT_CODE_PREFIX = 'GG';
export const DISCOUNT_CODE_RANDOM_LENGTH = 8;
export const DISCOUNT_CODE_PATTERN = new RegExp(
  `^${DISCOUNT_CODE_PREFIX}[${PROMO_CODE_ALPHABET}]{${String(DISCOUNT_CODE_RANDOM_LENGTH)}}$`,
);
/**
 * A generated bonus code has at least 10 random characters of the alphabet: 30^10 ≈ 5.9 × 10^14,
 * about 49 bits (docs/10), against the per-user and per-IP attempt limits.
 */
export const BONUS_CODE_RANDOM_MIN_LENGTH = 10;

/** The canonical form: Latin capitals and digits only. */
export const PROMO_CODE_PATTERN = new RegExp(
  `^[A-Z0-9]{${String(PROMO_CODE_MIN_LENGTH)},${String(PROMO_CODE_MAX_LENGTH)}}$`,
);

/**
 * The longest typed code (spaces, dashes and invisible characters included). The request schemas
 * of POST /bonus-codes/redeem and POST /quotes (`discountCode`) use this same bound, so a huge
 * body is refused before any string work is done on it.
 */
export const PROMO_CODE_RAW_MAX_LENGTH = 64;

// Every dash a phone keyboard or a copy from a chat may put between groups (`GG-7KQ2-MXP4`, the en
// dash of an autocorrect): hyphen-minus, the U+2010..2015 dashes, the minus sign, the small and the
// full-width hyphen-minus. By code point on purpose: look-alike dashes never appear in this file.
const DASHES: ReadonlySet<string> = new Set(
  [0x002d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe63, 0xff0d].map(
    (codePoint) => String.fromCodePoint(codePoint),
  ),
);

// Cyrillic capitals that look exactly like a Latin capital (a code typed on a Russian or Uzbek
// Cyrillic layout), by code point so the source never shows a Cyrillic letter that reads as
// Latin. Only true look-alikes: Ze is not 3 and Pe is not N, so they stay invalid.
const CYRILLIC_LOOKALIKES: ReadonlyMap<string, string> = new Map(
  (
    [
      [0x0410, 'A'],
      [0x0412, 'B'],
      [0x0415, 'E'],
      [0x041a, 'K'],
      [0x041c, 'M'],
      [0x041d, 'H'],
      [0x041e, 'O'],
      [0x0420, 'P'],
      [0x0421, 'C'],
      [0x0422, 'T'],
      [0x0423, 'Y'],
      [0x0425, 'X'],
    ] as const
  ).map(([codePoint, latin]) => [String.fromCodePoint(codePoint), latin]),
);

// Invisible format characters (Unicode Cf): zero-width space and joiners, word joiner, soft
// hyphen, LRM/RLM and the bidi overrides. A copied code may carry them; they are never part of it.
const FORMAT_CHAR = /^\p{Cf}$/u;

/** A space of any kind (`trim` knows every Unicode space and line break), a dash or a Cf char. */
function isSeparator(char: string): boolean {
  return char.trim() === '' || DASHES.has(char) || FORMAT_CHAR.test(char);
}

/**
 * The canonical form of a typed code, or null when it cannot be a code at all. Steps: NFKC (full
 * width letters become ASCII), upper case, drop spaces and dashes, Cyrillic look-alikes to Latin,
 * then the pattern. A null is answered exactly like an unknown code (`CODE_INVALID`), so the
 * shape of a refusal says nothing about which codes exist.
 */
export function normalizePromoCode(input: string): string | null {
  if (input.length > PROMO_CODE_RAW_MAX_LENGTH) return null;
  const canonical = [...input.normalize('NFKC').toUpperCase()]
    .filter((char) => !isSeparator(char))
    .map((char) => CYRILLIC_LOOKALIKES.get(char) ?? char)
    .join('');
  return PROMO_CODE_PATTERN.test(canonical) ? canonical : null;
}

/** True when every character of a canonical code is in the generated-code alphabet. */
export function isGeneratedCodeAlphabet(code: string): boolean {
  return [...code].every((char) => PROMO_CODE_ALPHABET.includes(char));
}
