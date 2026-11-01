import { REDACTED, isSensitiveField, isSensitiveKey, isValueDependentKey } from './keys';

// `key: value` forms inside free text: stringified JSON (`"apiKey":"x"`, also stringified
// twice: `\"apiKey\":\"x\"`), util.inspect / axios dumps (`{ apiKey: 'x' }`, `{'token': 'x'}`)
// and header-style lines (`x-api-key: x`, `Authorization: Paycom:x`).
//
// Cost model (reviewer / auditor RA-1): the key is classified BEFORE its value is looked at,
// and only a sensitive key triggers a value scan. A value scan is bounded and, when it hits
// the bound or the end of the text without closing, swallows the rest of the text (fail
// closed). Because the scan consumes what it redacts, the total work stays linear.
//
// The pattern stops at the colon; whitespace after it is skipped by hand, and only for a key
// that is sensitive. A bound on that whitespace was a bypass (ten tabs after the colon hid the
// value). Whitespace before the colon may be matched: a start cannot sit inside a key
// (lookbehind), so each whitespace run is scanned by one key only. A quoted key may contain
// spaces ("api key"); its class excludes quotes, so a start at one quote never scans past the
// next quote and quote-heavy text stays linear. Key length is capped to bound the backtracking.
const KEY_COLON =
  /(?<![A-Za-z0-9_.-])(?:(\\?["'])([A-Za-z0-9_. -]{1,256})(\\?["'])|(\\?["']?)([A-Za-z0-9_.-]{1,256})(\\?["']?))\s*:/g;

const MAX_VALUE_SCAN = 4096;

// Values that are a phrase, not one token: seed words, whole header lines. They run to the end
// of the line. This is about how far the value extends, not about what is secret: the secrecy
// verdict always comes from isSensitiveField.
export const LINE_VALUE_KEY = /mnemonic|seed|authorization|cookie|authheader|basicauth/i;

// `Authorization: Basic <token>` keeps the scheme word, which is useful in a log.
const AUTH_SCHEME_PREFIX = /^(?:Bearer|Basic)[ \t]+/i;

// A one-time code value: six digits, optionally quoted (also JSON-escaped).
const OTP_VALUE = /^(\\?["']?)(\d{6})(?!\d)(\\?["']?)/;

function isBareStop(char: string, untilLineEnd: boolean): boolean {
  if (untilLineEnd) return char === '\n' || char === '\r';
  return /[\s,;)}\]]/.test(char);
}

// Where the value starting at `start` ends: a string, a balanced {...} / [...] (string
// aware, both quote kinds), or a bare run of characters.
function valueEnd(text: string, start: number, untilLineEnd: boolean): number {
  const first = text.charAt(start);
  const limit = Math.min(text.length, start + MAX_VALUE_SCAN);
  if (first === '\\' && text.charAt(start + 1) === '"') {
    const close = text.indexOf('\\"', start + 2);
    return close === -1 || close + 2 > limit ? text.length : close + 2;
  }
  if (first === '"' || first === "'" || first === '{' || first === '[') {
    const isString = first === '"' || first === "'";
    let depth = isString ? 0 : 1;
    let quote = isString ? first : '';
    for (let i = start + 1; i < limit; i += 1) {
      const char = text.charAt(i);
      if (quote !== '') {
        if (char === '\\') {
          i += 1;
        } else if (char === quote) {
          quote = '';
          if (depth === 0) return i + 1;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return text.length;
  }
  let end = start;
  while (end < limit && !isBareStop(text.charAt(end), untilLineEnd)) end += 1;
  return end === limit && limit < text.length ? text.length : end;
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
  return i;
}

// Where the secret value of this key ends (and where it starts, after the whitespace that
// follows the colon), or null when this key/value pair is not a secret.
function secretValueSpan(
  text: string,
  key: string,
  afterColon: number,
): { start: number; end: number } | null {
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  if (isSensitiveKey(key) || isSensitiveKey(leaf)) {
    const start = skipWhitespace(text, afterColon);
    return { start, end: valueEnd(text, start, LINE_VALUE_KEY.test(key)) };
  }
  if (isValueDependentKey(key) || isValueDependentKey(leaf)) {
    // Only an OTP-shaped scalar counts; never scan structure for a non-sensitive key.
    const start = skipWhitespace(text, afterColon);
    const otp = OTP_VALUE.exec(text.slice(start, start + 16));
    if (otp !== null && isSensitiveField(leaf, otp[2]))
      return { start, end: start + otp[0].length };
  }
  return null;
}

function replacement(openQuote: string, raw: string): string {
  const first = raw.charAt(0);
  const wrap =
    openQuote === '\\"' || openQuote === '"'
      ? openQuote
      : first === '"' || first === "'"
        ? first
        : raw.startsWith('\\"')
          ? '\\"'
          : '';
  if (wrap === '') {
    const scheme = AUTH_SCHEME_PREFIX.exec(raw);
    return scheme === null ? REDACTED : `${scheme[0]}${REDACTED}`;
  }
  return `${wrap}${REDACTED}${wrap}`;
}

/** Capture group `index`, or '' when it did not take part in the match. */
export function group(match: RegExpMatchArray, index: number): string {
  return match[index] ?? '';
}

export function scrubKeyedFields(text: string): string {
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(KEY_COLON)) {
    // Groups 1-3: a quoted key (may contain spaces); 4-6: bare or loosely quoted key.
    const openQuote = group(match, 1) || group(match, 4);
    const key = group(match, 2) || group(match, 5);
    if (match.index < cursor) continue; // inside a value that is already replaced
    const span = secretValueSpan(text, key, match.index + match[0].length);
    if (span === null || span.end <= span.start) continue;
    const { start: valueStart, end } = span;
    const raw = text.slice(valueStart, end);
    if (raw === 'null') continue; // nothing to protect
    out += text.slice(cursor, valueStart) + replacement(openQuote, raw);
    cursor = end;
  }
  return out + text.slice(cursor);
}
