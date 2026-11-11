/** Telegram never delivers a longer message text; anything longer is not a bank notification. */
export const MAX_MESSAGE_LENGTH = 4096;

// Text and emoji presentation selectors (U+FE0E, U+FE0F): a marker arrives with or without one.
const VARIATION_SELECTORS = /[\u{FE0E}\u{FE0F}]/gu;
// Space-like characters banks and clients use as separators: NBSP, the U+2000..U+200A spaces
// (en/em/figure/thin/hair ...), narrow NBSP, medium math space, ideographic space.
const SPACE_LIKE = /[\u{00A0}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}]/gu;
// CRLF, CR, LF, NEL (U+0085), line separator (U+2028), paragraph separator (U+2029).
const LINE_BREAK = /\r\n|[\r\n\u{0085}\u{2028}\u{2029}]/u;
const HORIZONTAL_RUN = /[ \t]+/g;

/**
 * Message text → its non-empty lines, in order (docs/05-PAYMENTS.md §5, rule 1): NFC, variation
 * selectors removed, the space-like separators turned into a plain space, runs of spaces
 * collapsed, each line trimmed, blank lines dropped. Collapsing a run cannot change a value:
 * every pattern downstream expects single spaces, so a doubled one would only fail the line.
 */
export function normalizeLines(text: string): string[] {
  return text
    .normalize('NFC')
    .replace(VARIATION_SELECTORS, '')
    .replace(SPACE_LIKE, ' ')
    .split(LINE_BREAK)
    .map((line) => line.replace(HORIZONTAL_RUN, ' ').trim())
    .filter((line) => line.length > 0);
}
