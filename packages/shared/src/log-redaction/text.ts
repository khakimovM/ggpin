import { REDACTED, isSensitiveField } from './keys';

// Secrets also hide inside strings that are not under a sensitive key: an error message
// quoting a connection URL, a Telegram API URL that embeds the bot token, a logged query
// string, a request body that was stringified before logging. These patterns are the second
// line of defence for free text.

const URL_USERINFO = /(:\/\/)[^\s/?#]*@/g; // scheme://user:pass@host -> scheme://[Redacted]@host
const BOT_TOKEN = /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g; // 123456789:AA..., also inside /bot<token>/
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// Uzbek numbers: +998 90 123 45 67 in any common spacing. Anchored on both sides so longer
// digit runs (amounts, ids) are not touched.
const PHONE =
  /(?<!\w)\+?998[\s().-]{0,2}\d{2}[\s().-]{0,2}\d{3}[\s().-]{0,2}\d{2}[\s().-]{0,2}\d{2}(?!\d)/g;

// `key=value` after a query separator or whitespace: covers URLs (?token=..) and libpq-style
// connection strings (host=db password=..). A quoted value is consumed up to its closing
// quote (or to the end when unterminated: fail closed), otherwise `password="x"` would leave
// the value behind the replacement.
const KEY_VALUE_PAIR = /(^|[\s?&;,])([A-Za-z0-9_.-]+)=("[^"]*"?|'[^']*'?|[^&\s#"';,]*)/g;

// `"apiKey": "abc"` inside a string (a stringified body or log payload). The optional
// backslashes cover JSON that was stringified twice (`\"apiKey\":\"abc\"`).
const JSON_FIELD = /(\\?")([A-Za-z0-9_.-]+)\\?"(\s*:\s*)/g;

// Where the JSON value starting at `start` ends: a string, a balanced {...} / [...] (string
// aware), or a bare scalar. Unbalanced input runs to the end of the text so a truncated
// secret is still hidden.
function jsonValueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '\\' && text[start + 1] === '"') {
    const close = text.indexOf('\\"', start + 2);
    return close === -1 ? text.length : close + 2;
  }
  if (first === '"' || first === '{' || first === '[') {
    let depth = first === '"' ? 0 : 1;
    let inString = first === '"';
    for (let i = start + 1; i < text.length; i += 1) {
      const char = text[i];
      if (char === '\\') {
        i += 1;
      } else if (char === '"') {
        inString = !inString;
        if (!inString && depth === 0) return i + 1;
      } else if (!inString && (char === '{' || char === '[')) {
        depth += 1;
      } else if (!inString && (char === '}' || char === ']')) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return text.length;
  }
  let end = start;
  while (end < text.length && !/[,}\]\s]/.test(text.charAt(end))) end += 1;
  return end;
}

function scrubJsonFields(text: string): string {
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(JSON_FIELD)) {
    const [whole, quote = '"', key = ''] = match;
    const valueStart = match.index + whole.length;
    if (valueStart < cursor) continue; // inside a value that is already replaced
    const end = jsonValueEnd(text, valueStart);
    const raw = text.slice(valueStart, end);
    if (raw === 'null') continue; // nothing to protect
    const scalar = raw.replace(/^\\?"|\\?"$/g, '');
    if (!isSensitiveField(key, scalar)) continue;
    const wrapped = quote === '"' ? `"${REDACTED}"` : `\\"${REDACTED}\\"`;
    out += text.slice(cursor, valueStart) + wrapped;
    cursor = end;
  }
  return out + text.slice(cursor);
}

export function scrubSecretsInText(text: string): string {
  return scrubJsonFields(text)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(BOT_TOKEN, REDACTED)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(PHONE, REDACTED)
    .replace(KEY_VALUE_PAIR, (pair, separator: string, key: string, value: string) =>
      isSensitiveField(key, value.replace(/^["']|["']$/g, ''))
        ? `${separator}${key}=${REDACTED}`
        : pair,
    );
}
