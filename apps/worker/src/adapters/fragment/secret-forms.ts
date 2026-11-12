import type { SecretKind } from './sanitizer-rules';
import { parseTonAddress, tonAddressForms } from './ton-address-forms';

// How a known secret can be spelled in a page, a JSON body or a URL: every character in any of
// its encodings (literal, %XX of its UTF-8 bytes, JSON \uXXXX per code unit, HTML decimal/hex/named
// entity), spaces as \s, &nbsp;, &#160;, + or %20. Used by the sanitizer only; the leak check
// (leak-check.ts) decodes on its own and never uses these patterns.

export interface SecretValue {
  readonly kind: SecretKind;
  readonly value: string;
}

/** Shorter values are only redacted by key/pattern rules (`stel_dt` is a timezone offset). */
export const MIN_LENGTH: Readonly<Record<SecretKind, number>> = {
  cookie: 8,
  hash: 6,
  name: 3,
  username: 3,
  photo: 8,
  recipient: 6,
  address: 8,
  wallet: 8,
  tg_id: 5,
  phone: 7,
  secret: 3,
};

/** A secret starts/ends at a non-word character, or right after a %XX escape (S-2). */
export const BOUNDARY_BEFORE = '(?:(?<=%[0-9A-Fa-f]{2})|(?<![A-Za-z0-9_]))';
export const BOUNDARY_AFTER = '(?![A-Za-z0-9_])';

const SPACE = String.raw`(?:\s|&nbsp;|&#0*160;|&#x0*a0;|&#0*32;|&#x0*20;|\\u00a0|\\u0020|\+|%20|%C2%A0)+`;
const NAMED: Readonly<Record<string, readonly string[]>> = {
  '&': ['&amp;', '&#38;', '&#038;', '&#x26;'],
  '<': ['&lt;', '&#60;', '&#x3c;'],
  '>': ['&gt;', '&#62;', '&#x3e;'],
  '"': ['&quot;', '&#34;', '&#034;', '&#x22;', '\\"'],
  "'": ['&#39;', '&#039;', '&#x27;', '&apos;'],
  '/': ['\\/'],
};

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

/**
 * Apostrophe look-alikes (F-2): Uzbek o‘/g‘ and the tutuq belgisi are typed with any of them, so a
 * name given with one is matched in a page that shows another.
 */
const APOSTROPHES = [0x27, 0x60, 0xb4, 0x2018, 0x2019, 0x2bb, 0x2bc].map((c) =>
  String.fromCharCode(c),
);

/** Every spelling of one code point, as regex alternatives. */
function charAlternatives(ch: string): string[] {
  const code = ch.codePointAt(0) ?? 0;
  const alternatives = new Set<string>([escapeRegex(ch)]);
  for (const named of NAMED[ch] ?? []) alternatives.add(escapeRegex(named));
  // Letters too: a page may spell a whole name as entities (`&#79;&#122;...`).
  const utf8 = [...Buffer.from(ch, 'utf8')].map((b) => `%${hex(b, 2)}`).join('');
  alternatives.add(escapeRegex(utf8));
  const units = ch.length === 2 ? [ch.charCodeAt(0), ch.charCodeAt(1)] : [code];
  alternatives.add(units.map((u) => `\\\\u${hex(u, 4)}`).join(''));
  alternatives.add(`&#0*${code};`);
  alternatives.add(`&#x0*${hex(code, 1)};`);
  return [...alternatives];
}

/** A regex source that matches `value` spelled with any mix of encodings, per character. */
export function spelledAnyWay(value: string): string {
  const parts: string[] = [];
  let pendingSpace = false;
  for (const ch of value) {
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && parts.length > 0) parts.push(SPACE);
    pendingSpace = false;
    const alternatives = APOSTROPHES.includes(ch)
      ? [...new Set(APOSTROPHES.flatMap(charAlternatives))]
      : charAlternatives(ch);
    parts.push(
      alternatives.length === 1 ? (alternatives[0] ?? '') : `(?:${alternatives.join('|')})`,
    );
  }
  return parts.join('');
}

const NAME_SEPARATORS = new RegExp(
  String.raw`[\s".,;:!?()&/\\+\-–—${APOSTROPHES.map(escapeRegex).join('')}]+`,
  'u',
);

/** The words of a name (m4): 3+ code points, split on spaces and punctuation. */
export function nameWords(name: string): string[] {
  return name
    .split(NAME_SEPARATORS)
    .filter((word) => [...word].length >= 3 && /[\p{L}\p{N}]/u.test(word));
}

/** All text forms of one TON account, JSON-escaped and URL-encoded too (S-3). */
export function addressForms(value: string): string[] {
  const id = parseTonAddress(value);
  if (id === null) return [value];
  const forms = new Set<string>();
  for (const form of tonAddressForms(id)) {
    forms.add(form);
    forms.add(form.replace(/\//g, '\\/'));
    forms.add(encodeURIComponent(form));
    forms.add(form.replace(':', '%3A'));
  }
  return [...forms];
}

/** The value with %XX escapes decoded (N4): a cookie may be echoed decoded. */
function decodedValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const DIGIT_GAP = String.raw`[^\dA-Za-z<>"]{0,3}`;

/** A digit sequence with up to 3 separator characters between digits. */
function digitRun(digits: string): string {
  return `(?<!\\d)${[...digits].join(DIGIT_GAP)}(?!\\d)`;
}

export interface ExactPattern {
  readonly kind: SecretKind;
  readonly source: string;
  readonly flags: string;
}

/** The regex sources for one secret (the full value, and each name word on its own). */
export function exactPatterns(secret: SecretValue): ExactPattern[] {
  const value = secret.value.trim();
  if ([...value].length < MIN_LENGTH[secret.kind]) return [];
  const { kind } = secret;
  if (kind === 'address') {
    const forms = addressForms(value).sort((a, b) => b.length - a.length);
    return [{ kind, source: forms.map(escapeRegex).join('|'), flags: 'g' }];
  }
  if (kind === 'name' || kind === 'secret') {
    // NFC and NFD spellings both (audit NFD1, NFD2).
    const forms = new Set<string>();
    for (const v of [value, ...nameWords(value)]) {
      for (const n of [v, v.normalize('NFC'), v.normalize('NFD')]) forms.add(n);
    }
    const values = [...forms].sort((a, b) => b.length - a.length);
    return values.map((v) => ({
      kind,
      source: `${BOUNDARY_BEFORE}${spelledAnyWay(v)}${BOUNDARY_AFTER}`,
      flags: 'gi',
    }));
  }
  if (kind === 'username') return [{ kind, source: spelledAnyWay(value), flags: 'gi' }];
  if (kind === 'tg_id' || kind === 'phone') {
    // Digits with any separators between them (R-9): `90 123 45 67`, `700,100,200`.
    const digits = value.replace(/\D/g, '');
    const patterns = [{ kind, source: digitRun(digits), flags: 'g' }];
    // The last 9 digits with ANY prefix (R-9): `+7 916…` is also written `8 (916)…` or `916…`.
    if (kind === 'phone' && digits.length > 9) {
      const tail = digitRun(digits.slice(-9)).replace('(?<!\\d)', '');
      patterns.push({ kind, source: `(?<!\\d)(?:\\d${DIGIT_GAP})*${tail}`, flags: 'g' });
    }
    return patterns;
  }
  const forms = [
    ...new Set([
      value,
      decodedValue(value),
      encodeURIComponent(value),
      value.replace(/\//g, '\\/'),
    ]),
  ];
  const sorted = forms.sort((a, b) => b.length - a.length).map(escapeRegex);
  return [{ kind, source: sorted.join('|'), flags: kind === 'hash' ? 'gi' : 'g' }];
}
