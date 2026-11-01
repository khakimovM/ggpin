import { REDACTED, isSensitiveField } from './keys';
import { scrubKeyedFields } from './text-fields';

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

// `key=value` after a query separator or whitespace: covers URLs (?token=..) and libpq-style
// connection strings (host=db password=..). A quoted value is consumed up to its closing
// quote (or to the end when unterminated: fail closed), otherwise `password="x"` would leave
// the value behind the replacement.
const KEY_VALUE_PAIR = /(^|[\s?&;,])([A-Za-z0-9_.-]+)=("[^"]*"?|'[^']*'?|[^&\s#"';,]*)/g;

function scrub(text: string): string {
  return scrubKeyedFields(text)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(BOT_TOKEN, REDACTED)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(INTL_PHONE, REDACTED)
    .replace(PHONE, REDACTED)
    .replace(LOCAL_PHONE, REDACTED)
    .replace(KEY_VALUE_PAIR, (pair, separator: string, key: string, value: string) =>
      isSensitiveField(key, value.replace(/^["']|["']$/g, ''))
        ? `${separator}${key}=${REDACTED}`
        : pair,
    );
}

/**
 * Hides secrets in free text. At most `maxLength` characters are examined; the rest is
 * dropped and replaced by TRUNCATED. The parameter exists for the performance tests.
 */
export function scrubSecretsInText(text: string, maxLength = MAX_SCRUBBED_LENGTH): string {
  if (text.length <= maxLength) return scrub(text);
  return `${scrub(text.slice(0, maxLength))}${TRUNCATED}`;
}
