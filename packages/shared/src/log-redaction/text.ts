import { REDACTED } from './keys';
import { scrubKeyedFields } from './text-fields';
import { scrubKeyValuePairs } from './text-pairs';

// Secrets also hide inside strings that are not under a sensitive key: an error message
// quoting a connection URL, a Telegram API URL that embeds the bot token, a logged query
// string, a request body that was stringified before logging. These patterns are the second
// line of defence for free text.
//
// Every pattern here must stay linear on adversarial input (see text.perf.test.ts): bounded
// repeats, no nested unbounded quantifiers, and a hard cap on how much of a string is
// examined at all.

export const TRUNCATED = '[Truncated]';

/** Text beyond this is not scanned; it is replaced by TRUNCATED (fail closed). */
export const MAX_SCRUBBED_LENGTH = 16 * 1024;

const URL_USERINFO = /(:\/\/)[^\s/?#]*@/g; // scheme://user:pass@host -> scheme://[Redacted]@host
const BOT_TOKEN = /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g; // 123456789:AA..., also inside /bot<token>/
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// The pay-link token: `#t=` (the current form, D-37 (15)), `?t=` and `&t=` (the retired query
// form, in case an old link is logged), and the same three URL-encoded (`%23t%3D`, `%3Ft%3D`,
// `%26t%3D`: a link logged inside another URL). Only the value is hidden.
const PAY_TOKEN_PARAM = /((?:[?&#]|%23|%3f|%26)t(?:=|%3d))[A-Za-z0-9_-]{8,}/gi;

// A card number: 16 digits, optionally in groups separated by one space, no-break/thin/narrow
// space or dash, not part of a longer word or digit run. Our own card ranges (Uzcard 8600, Humo
// 9860, UnionPay 5614) are hidden whatever the check digit says; any other 16 digits only when
// they pass the Luhn check, so an arbitrary 16-digit id is not hit.
const CARD_NUMBER = /(?<![\w.])(?:\d[ \u00A0\u2009\u202F-]?){15}\d(?!\w)/g;
const LOCAL_CARD_RANGE = /^(?:8600|9860|5614)/;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hideCardNumber(match: string): string {
  const digits = match.replace(/\D/g, '');
  return LOCAL_CARD_RANGE.test(digits) || passesLuhn(digits) ? REDACTED : match;
}

// Phone numbers. Uzbek: +998 90 123 45 67 in any common spacing, anchored on both sides so
// longer digit runs (amounts, ids) are not touched.
const PHONE =
  /(?<!\w)\+?998[\s().-]{0,2}\d{2}[\s().-]{0,2}\d{3}[\s().-]{0,2}\d{2}[\s().-]{0,2}\d{2}(?!\d)/g;
// International: a leading `+` and 10-15 digits with up to two separators between digits
// (`+7 912 345 67 89`). Without the `+` a digit run is not treated as a phone: tiyin amounts
// look exactly like a bare 9-digit number.
const INTL_PHONE = /(?<![\w+])\+\d(?:[\s().-]{0,2}\d){9,14}(?!\d)/g;
// Spaced local format `90 123 45 67`. Needs the separators for the same reason; `.` is not a
// separator here so dotted IPv4 fragments are left alone.
const LOCAL_PHONE = /(?<![\w.+-])\d{2}[ -]\d{3}[ -]\d{2}[ -]\d{2}(?![\w-])/g;

function scrub(text: string): string {
  const scrubbed = scrubKeyedFields(text)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(BOT_TOKEN, REDACTED)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(PAY_TOKEN_PARAM, `$1${REDACTED}`)
    .replace(CARD_NUMBER, hideCardNumber)
    .replace(INTL_PHONE, REDACTED)
    .replace(PHONE, REDACTED)
    .replace(LOCAL_PHONE, REDACTED);
  return scrubKeyValuePairs(scrubbed);
}

// Where a secret can start: a token ends at whitespace or one of these.
const CUT_DELIMITER = /[\s&;,"')}\]]/;
// Trailing characters of a half-seen phone number ("+998 90 123 4").
const PHONE_TAIL = /[\d\s+().-]/;

// The scan cap must not cut through a secret: `Bearer abcde` or half a bot token no longer
// matches any pattern, so the prefix would be written to the log. The head therefore ends
// before its last delimiter, and before any phone-number tail; with no delimiter at all the
// whole head is dropped (fail closed).
function safeHead(text: string, maxLength: number): string {
  let end = maxLength - 1;
  while (end >= 0 && !CUT_DELIMITER.test(text.charAt(end))) end -= 1;
  while (end > 0 && PHONE_TAIL.test(text.charAt(end - 1))) end -= 1;
  return end <= 0 ? '' : text.slice(0, end);
}

/**
 * Hides secrets in free text. At most `maxLength` characters are examined; the rest is
 * dropped and replaced by TRUNCATED; the cut is moved back to a delimiter (see safeHead). The
 * parameter exists for the performance tests.
 */
export function scrubSecretsInText(text: string, maxLength = MAX_SCRUBBED_LENGTH): string {
  if (text.length <= maxLength) return scrub(text);
  return `${scrub(safeHead(text, maxLength))}${TRUNCATED}`;
}
