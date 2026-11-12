// Generic secret SHAPES (round 4, L-1, L-3, I-3): a cookie pair, the API hash, a base64 image and
// phone numbers, recognised without knowing the value. The sanitizer redacts them and the leak
// check flags them with the SAME expressions, so a harmless construct the sanitizer leaves alone
// is never withheld (F-7). These shapes are therefore not an independent second opinion; the leak
// check's per-secret probes and its decoding (leak-views.ts) still are.
// Every expression is global and case-insensitive; the leak check runs them on lower-cased views.

/** `:`/`=` and their entity / %XX spellings between a key and its value. */
const SEP = String.raw`\s*(?:[:=]|&equals;|&colon;|&#0*(?:61|58);|&#x0*(?:3d|3a);|%3[da])\s*`;
const OPEN_QUOTE = String.raw`(?:\\?["']|&quot;|&#0*(?:34|39);|&#x0*(?:22|27);)?`;
const KEY_QUOTE = String.raw`\\?["']?`;
const VALUE_CHAR = String.raw`[^\s;"'<>&,\\)(]`;
/** Not a value: a placeholder, or JS building the cookie (`'stel_dt='+offset`). */
const NOT_VALUE = String.raw`(?!<redacted|["']?\s*\+)`;

/** Group 1 is kept, group 2 is the secret value. */
export const COOKIE_SHAPES: readonly RegExp[] = [
  // stel_x=v, stel_x: v, "stel_x":"v", {stel_x:'v'}, stel_x&equals;v, \"stel_x\":\"v\" (L-1).
  new RegExp(`(stel_[a-z0-9_]+${KEY_QUOTE}${SEP}${OPEN_QUOTE})${NOT_VALUE}(${VALUE_CHAR}+)`, 'gi'),
  // ["stel_x","v"] (L-1, array form); a list of cookie NAMES (`["stel_dt","stel_ssid"]`) is not.
  new RegExp(
    String.raw`(["']stel_[a-z0-9_]+\\?["']\s*,\s*\\?["'])(?!<redacted|stel_)([^"'\\\s]+)`,
    'gi',
  ),
  // name=stel_x&value=v, {"name":"stel_x","value":"v"} (L-1, name/value pairs).
  new RegExp(
    `(name${KEY_QUOTE}${SEP}${OPEN_QUOTE}stel_[a-z0-9_]+${KEY_QUOTE}\\s*[,&;]\\s*${KEY_QUOTE}value${KEY_QUOTE}${SEP}${OPEN_QUOTE})(?!<redacted)(${VALUE_CHAR}+)`,
    'gi',
  ),
];

/** hash=, api_hash=, apiHash:, "hash":"h", data-hash="h", /api/hash/h (L-1); not `infohash=`. */
export const HASH_SHAPE = new RegExp(
  String.raw`((?<![a-z0-9])(?:api_?)?hash${KEY_QUOTE}\s*(?:[:=/]|&equals;|&colon;|&#0*(?:61|58);|&#x0*(?:3d|3a);|%3[da])\s*${OPEN_QUOTE})(?!<redacted)([0-9a-f]{6,})(?![0-9a-z])`,
  'gi',
);

/** Any base64 data URI (I-3): `data:<anything up to 80>;base64,`, also wrapped over lines. */
export const PHOTO_DATA = /data:[^,"'<>\s]{0,80};base64,(?:\s|\\[/nr]|[A-Za-z0-9+/=])+/gi;

const UZ = String.raw`(?:9\d|33|88|77|20|50|55)`;
/** A whole phone word (`Telegram` is not `tel`), with its common endings (`raqami`, `номера`). */
const PHONE_WORD = String.raw`(?<![a-zа-яё])(?:tel(?:efon|ephone)?|phone(?:_?number)?|mobil[a-z]?|raqam[a-z]{0,5}|телефон[а-я]{0,3}|номер[а-я]{0,3})(?![a-zа-яё])`;

/** Phone numbers, whole match (F-3, L-3). */
export const PHONE_SHAPES: readonly RegExp[] = [
  /(?<![\w+])\+\d[\d\s().-]{7,18}\d(?!\d)/g,
  /(?<!\d)998[\s-]?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g,
  /(?<![\d+])8[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g,
  /(?<![\d+])\d{2} \d{3} \d{2} \d{2}(?!\d)/g,
  /(?<![\d-])\d{2}-\d{3}-\d{2}-\d{2}(?![\d-])/g,
  /(?<![\d)])\(\d{2}\)\s?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g,
  new RegExp(String.raw`(?<![\d+.])${UZ} \d{7}(?!\d)`, 'g'),
  new RegExp(String.raw`(?<![\d.])${UZ}\.\d{3}\.\d{2}\.\d{2}(?![\d.])`, 'g'),
  // A bare Uzbek mobile number after a phone word, or alone in an element (`<b>901234567</b>`).
  new RegExp(String.raw`(?<=${PHONE_WORD}[^\d<>"]{0,12})(?<!\d)${UZ}\d{7}(?!\d)`, 'gi'),
  new RegExp(String.raw`(?<=>\s*)${UZ}\d{7}(?=\s*<)`, 'g'),
];

/** True when `re` matches anywhere in `text` (a fresh copy: no shared `lastIndex`). */
export function hasShape(re: RegExp, text: string): boolean {
  return new RegExp(re.source, re.flags.replace('g', '')).test(text);
}
