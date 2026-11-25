// A `payload` key in free text (P6-S0a fix round, CR F4/F5, SA F6): page scripts and text may
// carry it with a single-quoted, unquoted, JSON-escaped or entity-quoted key, and its value may be
// a string, an object or an array. Whatever it holds becomes the payload placeholder; a value
// whose end cannot be found is redacted to the end of the text (fail closed).

const QUOTE = String.raw`(?:\\{0,3}["'\x60]|&quot;|&#0*34;|&#0*39;|&apos;|%2[27])`;
// `:` or `=` (round 2, SA R5: `payload=…`, `"Payload" = "…"`), plain, entity or percent form.
const KEY = new RegExp(
  String.raw`(?<![A-Za-z0-9_$])(${QUOTE})?payload(${QUOTE})?\s*(?::|=|&#0*58;|&#0*61;|%3[AaDd])\s*`,
  'gi',
);
const VALUE_QUOTE = new RegExp(`^${QUOTE}`, 'i');
const BARE = /^[A-Za-z0-9+/=_.-]{8,}/;

/** The end (exclusive) of a bracketed value opening at `start`, or the text's end. */
function bracketEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Where the closing `open` quote of a value starting at `from` is, or -1 (not closed). */
function closingQuote(text: string, from: number, open: string): number {
  if (open === '"' || open === "'" || open === '`') {
    for (let i = from; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === open) return i;
    }
    return -1;
  }
  return text.toLowerCase().indexOf(open.toLowerCase(), from);
}

/** Redacts every `payload` value in `text` (the placeholder is the given string). */
export function redactPayloadText(text: string, redacted: string): string {
  let out = '';
  let last = 0;
  KEY.lastIndex = 0;
  for (let m = KEY.exec(text); m !== null; m = KEY.exec(text)) {
    const valueAt = m.index + m[0].length;
    if (valueAt < last) continue;
    const rest = text.slice(valueAt);
    let end: number;
    let replacement: string;
    const open = VALUE_QUOTE.exec(rest)?.[0];
    if (rest.startsWith('{') || rest.startsWith('[')) {
      end = bracketEnd(text, valueAt);
      replacement = `"${redacted}"`;
    } else if (open !== undefined) {
      const inner = valueAt + open.length;
      const close = closingQuote(text, inner, open);
      // Empty, or a placeholder follows (the text is cut at placeholders): nothing to redact.
      if (close === inner || inner === text.length) continue;
      if (text.slice(inner).toLowerCase().startsWith(redacted.toLowerCase())) continue;
      end = close === -1 ? text.length : close + open.length;
      replacement = `${open}${redacted}${close === -1 ? '' : open}`;
    } else {
      const bare = BARE.exec(rest)?.[0];
      if (bare === undefined) continue;
      end = valueAt + bare.length;
      replacement = redacted;
    }
    out += text.slice(last, valueAt) + replacement;
    last = end;
    KEY.lastIndex = Math.max(end, KEY.lastIndex);
  }
  return out + text.slice(last);
}
