import { REDACTED, isSensitiveKey, isSensitiveField, isValueDependentKey } from './keys';
import { LINE_VALUE_KEY, group } from './text-fields';

// `key=value` after a query separator or whitespace: covers URLs (?token=..) and libpq-style
// connection strings (host=db password=..). Spaces around `=` are allowed (`password = x`).
// The key may be dotted (`cfg.hash`, `q.code`) and is classified by its last segment too, as
// the `key: value` path does.
//
// The regex only finds `key =`; the value is measured by hand and only for a sensitive key.
// A non-sensitive key's value is NOT consumed: scanning resumes right after the `=`, so a
// quoted or unterminated value of a harmless key (`msg="failed host=db password=x`) cannot
// hide a later pair. A sensitive value is consumed, which keeps the total work linear.
const KEY_EQUALS = /(^|[\s?&;,])([A-Za-z0-9_.-]+)[ \t]*=[ \t]*/g;

// A one-time code value: six digits, bare or quoted. The slice is short because a code value
// never needs more.
const OTP_VALUE = /^(?:"(\d{6})"|'(\d{6})'|(\d{6})(?=[&\s#"';,]|$))/;
const OTP_LOOKAHEAD = 16;

const BARE_STOP = /[&\s#"';,]/;

// Where the value starting at `start` ends. A quoted value runs to its closing quote (a
// backslash escapes the next character) or, when unterminated, to the end of the text: fail
// closed, otherwise an unterminated `password="x` would leave the value behind.
function valueEnd(text: string, start: number, untilLineEnd: boolean): number {
  const first = text.charAt(start);
  if (first === '"' || first === "'") {
    for (let i = start + 1; i < text.length; i += 1) {
      const char = text.charAt(i);
      if (char === '\\') i += 1;
      else if (char === first) return i + 1;
    }
    return text.length;
  }
  let end = start;
  while (end < text.length) {
    const char = text.charAt(end);
    if (untilLineEnd ? char === '\n' || char === '\r' : BARE_STOP.test(char)) break;
    end += 1;
  }
  return end;
}

// End of a secret value for this key, or -1 when the pair is not a secret.
function secretEnd(text: string, key: string, valueStart: number): number {
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  if (isSensitiveKey(key) || isSensitiveKey(leaf)) {
    return valueEnd(text, valueStart, LINE_VALUE_KEY.test(key));
  }
  if (isValueDependentKey(key) || isValueDependentKey(leaf)) {
    const otp = OTP_VALUE.exec(text.slice(valueStart, valueStart + OTP_LOOKAHEAD));
    const digits = otp?.[1] ?? otp?.[2] ?? otp?.[3];
    if (otp !== null && digits !== undefined && isSensitiveField(leaf, digits)) {
      return valueStart + otp[0].length;
    }
  }
  return -1;
}

export function scrubKeyValuePairs(text: string): string {
  let out = '';
  let cursor = 0;
  KEY_EQUALS.lastIndex = 0;
  for (let match = KEY_EQUALS.exec(text); match !== null; match = KEY_EQUALS.exec(text)) {
    const valueStart = match.index + match[0].length;
    const end = secretEnd(text, group(match, 2), valueStart);
    if (end < 0) continue; // lastIndex is already just after the `=`
    out += `${text.slice(cursor, valueStart)}${REDACTED}`;
    cursor = end;
    KEY_EQUALS.lastIndex = end;
  }
  return out + text.slice(cursor);
}
