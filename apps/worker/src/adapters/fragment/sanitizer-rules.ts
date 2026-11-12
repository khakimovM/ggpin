import { NAME_CLASS } from './fragment-page';
import { BOUNDARY_BEFORE } from './secret-forms';
import { COOKIE_SHAPES, HASH_SHAPE, PHONE_SHAPES, PHOTO_DATA } from './secret-shapes';
import { parseTonAddress } from './ton-address-forms';

// Pattern rules of the fixture sanitizer: what can be recognised without knowing the value
// (cookie pairs, the API hash, photo URLs, e-mails, TON addresses, phone numbers, long random
// tokens, PII keys of JSON embedded in a page). Exact known values: secret-forms.ts.

export type SecretKind =
  | 'cookie'
  | 'hash'
  | 'name'
  | 'username'
  | 'photo'
  | 'recipient'
  | 'address'
  | 'wallet'
  | 'tg_id'
  | 'phone'
  | 'secret';

/** Every placeholder kind. Only these count as "already redacted" (audit P). */
export const PLACEHOLDER_KINDS = [
  'cookie',
  'hash',
  'name',
  'username',
  'photo',
  'photo-url',
  'photo-data',
  'recipient',
  'address',
  'wallet',
  'tg_id',
  'phone',
  'secret',
  'payload',
  'token',
  'email',
  'kyc',
] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

export function placeholder(kind: PlaceholderKind): string {
  return `<REDACTED:${kind}>`;
}

const PLACEHOLDER_SPLIT = new RegExp(`(<REDACTED:(?:${PLACEHOLDER_KINDS.join('|')})>)`);
const PLACEHOLDER_ONLY = new RegExp(`^<REDACTED:(?:${PLACEHOLDER_KINDS.join('|')})>$`);

export function isPlaceholder(text: string): boolean {
  return PLACEHOLDER_ONLY.test(text);
}

/** Applies `fn` to the text between placeholders only: what is redacted stays redacted. */
export function outsidePlaceholders(text: string, fn: (part: string) => string): string {
  return text
    .split(PLACEHOLDER_SPLIT)
    .map((part) => (PLACEHOLDER_ONLY.test(part) ? part : fn(part)))
    .join('');
}

const KEY_KINDS: ReadonlyArray<readonly [RegExp, PlaceholderKind]> = [
  [/^stel_/, 'cookie'],
  [/^(cookie|cookies|set-cookie)$/, 'cookie'],
  [/^(hash|api_hash|apihash)$/, 'hash'],
  [/^(username|user_name|query)$/, 'username'],
  // Any key holding a name, and a bare `title` (audit KEY1, KEY2): `item_title` stays.
  [/(?:^|_)name$|^(?:first|last|display|full|peer|account|user|sender)name$|^title$/, 'name'],
  [/^(photo|photo_url|avatar|userpic)$/, 'photo'],
  [/^recipient$/, 'recipient'],
  [/^(account|publickey|public_key|walletstateinit|wallet_state_init)$/, 'wallet'],
  [/^(user_id|userid|uid|tg_id|telegram_id|owner_id)$/, 'tg_id'],
  [/^(phone|phone_number|number)$/, 'phone'],
  [/email/, 'email'],
  [/kyc|verify/, 'kyc'],
  [/token|auth|session/, 'token'],
];

/** The kind of a JSON key whose string/number value is always redacted, or null. */
export function kindForKey(key: string): PlaceholderKind | null {
  const lower = key.toLowerCase();
  for (const [pattern, kind] of KEY_KINDS) if (pattern.test(lower)) return kind;
  return null;
}

const EMBEDDED_KEY = String.raw`[A-Za-z_]*(?:username|user_name|name|photo|phone|user_id|uid|tg_id|recipient|hash|email|token|auth|session|kyc|verify)[A-Za-z_]*`;

export interface PatternRule {
  readonly name: string;
  /** Runs before the exact-value rules (so an embedded JSON number stays a number). */
  readonly early?: boolean;
  readonly apply: (part: string) => string;
}

const PHOTO_HOSTS = ['telesco.pe', 'telegram-cdn.org', 'cdn-telegram.org'];

function isPhotoUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text.replace(/\\\//g, '/'), 'https://placeholder.invalid');
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (PHOTO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  if (url.pathname.includes('/userpic')) return true;
  return host.endsWith('telegram.org') && url.pathname.startsWith('/file/');
}

// Base64 characters, also when JSON-escaped (\/) or URL-encoded (%2B, %2F) (audit F, F2, F3).
const B64_CHAR = String.raw`(?:[A-Za-z0-9+/_-]|\\\/|%2[BbFf])`;
const FRIENDLY_ADDRESS = new RegExp(
  `${BOUNDARY_BEFORE.replace('A-Za-z0-9_', 'A-Za-z0-9+_-')}[EUk0][Qf]${B64_CHAR}{46}(?![A-Za-z0-9+_-])`,
  'g',
);
// A shortened address (`UQAB…wxyz`, `EQAB...wxyz`, `UQAB … wxyz`, `UQABcd***uvwxyz`; R-6, N3,
// F-4): redacted, nothing can be kept.
const SHORT_ADDRESS =
  /(?<![A-Za-z0-9_-])[EUk0][Qf][A-Za-z0-9_-]{2,6}\s*(?:…|\.\.\.?|\*{2,})\s*[A-Za-z0-9_-]{4,8}(?![A-Za-z0-9_-])/g;
// Tried at every position (audit E: `%220:<hex>`); the hash decides, the workchain digits do not.
const RAW_ADDRESS = /-?\d{0,3}(?::|%3[Aa])([0-9a-fA-F]{64})(?![0-9a-fA-F])/g;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long random-looking token (S-6): 32+ chars, letters and digits, high entropy. */
export function isRandomToken(text: string): boolean {
  return (
    text.length >= 32 &&
    /^[A-Za-z0-9+/_=.-]+$/.test(text) &&
    /\d/.test(text) &&
    /[A-Za-z]/.test(text) &&
    entropy(text) >= 3.8
  );
}

/**
 * The pattern rules, in order. `keep` are Fragment's public pay addresses (Q7), already without
 * any secret account: kept ONLY in the exact spelling given (audit KEEP3), so another form of the
 * same account is redacted.
 */
export function patternRules(keep: readonly string[]): PatternRule[] {
  const keepSet = new Set(keep);
  const keepRaw = new Set(
    keep.filter((k) => k.includes(':')).map((k) => (k.split(':')[1] ?? '').toLowerCase()),
  );
  const friendly = (match: string): string => {
    const plain = match
      .replace(/\\\//g, '/')
      .replace(/%2[Bb]/g, '+')
      .replace(/%2[Ff]/g, '/');
    if (parseTonAddress(plain) === null) return match;
    return keepSet.has(plain) ? match : placeholder('address');
  };
  const raw = (match: string, hex: string): string =>
    keepRaw.has(hex.toLowerCase()) ? match : placeholder('address');
  return [
    {
      name: 'embedded-json',
      early: true,
      apply: (part) =>
        part.replace(
          new RegExp(String.raw`("(${EMBEDDED_KEY})"\s*:\s*)("(?:[^"\\]|\\.)*"|\d+)`, 'gi'),
          (_m, prefix: string, key: string, value: string) => {
            if (value === '""') return `${prefix}${value}`;
            if (!value.startsWith('"')) return `${prefix}0`;
            return `${prefix}"${placeholder(kindForKey(key) ?? 'secret')}"`;
          },
        ),
    },
    {
      name: 'id-attribute',
      early: true,
      apply: (part) =>
        part
          .replace(
            /(data-[a-z-]*(?:user|uid|owner|peer|id)[a-z-]*=["']?)(\d{5,})/gi,
            (_m, prefix: string) => `${prefix}0`,
          )
          // A bare `"id": 700100200` in page JSON may be the user's id (audit G2): fail closed.
          .replace(/("id"\s*:\s*)\d{5,}(?!\d)/gi, (_m, prefix: string) => `${prefix}0`),
    },
    {
      // Text of an element whose class names a person (audit KEY4), even when the name is unknown.
      name: 'name-element',
      early: true,
      apply: (part) =>
        part.replace(
          new RegExp(`(class="[^"]*${NAME_CLASS}[^"]*"[^>]*>)([^<]+)(<)`, 'gi'),
          (_m, open: string, text: string, close: string) =>
            text.trim() === '' ? `${open}${text}${close}` : `${open}${placeholder('name')}${close}`,
        ),
    },
    {
      name: 'cookie',
      apply: (part) =>
        COOKIE_SHAPES.reduce(
          (text, re) => text.replace(re, (_m, keep: string) => `${keep}${placeholder('cookie')}`),
          part,
        ),
    },
    {
      name: 'hash',
      apply: (part) =>
        part.replace(HASH_SHAPE, (_m, keep: string) => `${keep}${placeholder('hash')}`),
    },
    {
      name: 'photo-url',
      apply: (part) =>
        part
          .replace(/(?:https?:)?(?:\\?\/){2}[^\s"'<>()]+/gi, (m) =>
            isPhotoUrl(m) ? placeholder('photo-url') : m,
          )
          .replace(PHOTO_DATA, placeholder('photo-data')),
    },
    {
      name: 'email',
      apply: (part) =>
        part.replace(
          /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
          placeholder('email'),
        ),
    },
    {
      name: 'address',
      apply: (part) =>
        part
          .replace(FRIENDLY_ADDRESS, friendly)
          .replace(RAW_ADDRESS, raw)
          .replace(SHORT_ADDRESS, placeholder('address')),
    },
    {
      name: 'phone',
      apply: (part) =>
        PHONE_SHAPES.reduce((text, re) => text.replace(re, placeholder('phone')), part),
    },
    {
      // Long hex is never kept (R-7), except a kept raw address hash.
      name: 'hex-token',
      apply: (part) =>
        part.replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g, (m) =>
          m.length === 64 && keepRaw.has(m.toLowerCase()) ? m : placeholder('token'),
        ),
    },
    {
      name: 'random-token',
      apply: (part) =>
        part.replace(/[A-Za-z0-9+_=.-]{32,}/g, (m) => {
          if (keepSet.has(m)) return m;
          return isRandomToken(m) ? placeholder('token') : m;
        }),
    },
  ];
}
