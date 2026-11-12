import { unifyApostrophes } from './leak-views';
import type { SecretValue } from './secret-forms';
import { parseTonAddress, tonAddressForms, type TonAccountId } from './ton-address-forms';

// What the leak check looks for, per known secret (S-1, R-1, R-6, N3, N4). Every probe runs on
// lower-cased decoded views. These per-secret probes share no pattern with the sanitizer's
// secret-forms.ts; only the generic shapes (secret-shapes.ts, used by leak-check.ts) are shared.

export interface Probe {
  readonly rule: string;
  readonly test: (view: string) => boolean;
}

const MIN: Readonly<Record<string, number>> = { cookie: 8, hash: 6, tg_id: 5, phone: 7 };
/** Hash and recipient values are also searched by every 12-character piece (R-1); a cookie by
 * every 8-character piece, so a cut-off echo (`first 11 characters`, R3 audit E20) is found. */
const PIECE = 12;
const COOKIE_PIECE = 8;
const WINDOW = 10;

const includesAny =
  (needles: readonly string[]) =>
  (view: string): boolean =>
    needles.some((n) => view.includes(n));

const WORDY = /[\p{L}\p{N}_]/u;

const wordIn =
  (word: string) =>
  (view: string): boolean => {
    let at = view.indexOf(word);
    while (at !== -1) {
      const before = view.slice(0, at).slice(-1);
      const after = view.slice(at + word.length).slice(0, 1);
      if (!WORDY.test(before) && !WORDY.test(after)) return true;
      at = view.indexOf(word, at + 1);
    }
    return false;
  };

/** Digits with up to 3 other characters between them (R-6: `700,100,200`, U+200B, `&shy;`). */
/** `anyPrefix`: a phone's last 9 digits also count after other digits (`8 (916)…`, R-9). */
function digitsProbe(digits: string, anyPrefix = false): (view: string) => boolean {
  const before = anyPrefix ? '' : '(?<!\\d)';
  const re = new RegExp(`${before}${[...digits].join('\\D{0,3}')}(?!\\d)`);
  return (view) => re.test(view);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The value, its URL-decoded form (N4) and, when long, every 12-character piece of both. */
function pieces(value: string, size = PIECE): string[] {
  const out = new Set<string>();
  for (const v of [value, decoded(value)].map((x) => x.toLowerCase())) {
    out.add(v);
    if (v.length > size)
      for (let i = 0; i + size <= v.length; i += 1) out.add(v.slice(i, i + size));
  }
  return [...out];
}

const nfc = (s: string): string[] => [
  ...new Set([s, s.normalize('NFC'), s.normalize('NFKC')].map((x) => x.toLowerCase())),
];

/** Space-separated pieces of a name, apostrophes unified, 3+ characters (L-2, M-1). */
export function namePieces(name: string): string[] {
  return unifyApostrophes(name.trim())
    .split(/\s+/)
    .filter((p) => [...p].length >= 3);
}

/** One name piece as a whole word, in any apostrophe and NFC/NFKC form (M-1). */
export function pieceProbe(piece: string): (view: string) => boolean {
  const tests = nfc(unifyApostrophes(piece)).map(wordIn);
  return (view) => tests.some((test) => test(view));
}

function words(value: string): string[] {
  return value.split(/[^\p{L}\p{N}_]+/u).filter((w) => [...w].length >= 3);
}

const ELLIPSIS =
  /([a-z0-9+/_-]{3,8})?\s*(?:…|\.{2,3}|\*{2,})\s*([a-z0-9+/_-]{4,8})?(?![a-z0-9+/_-])/g;

/** `first4…last4`, `…last4..8`, `first6…` of one of the forms (R-6, N3). */
function shortenedProbe(forms: readonly string[]): (view: string) => boolean {
  const lower = forms.map((f) => f.toLowerCase());
  return (view) => {
    for (const m of view.matchAll(ELLIPSIS)) {
      const left = m[1] ?? '';
      const right = m[2] ?? '';
      for (const f of lower) {
        const head = left.length >= 4 && f.startsWith(left);
        const tail = right.length >= 4 && f.endsWith(right);
        if ((head && tail) || tail || (left.length >= 6 && head)) return true;
      }
    }
    return false;
  };
}

function addressProbes(id: TonAccountId): Probe[] {
  const forms = tonAddressForms(id);
  const needles = new Set<string>([id.hash.toString('hex')]);
  for (const form of forms) {
    const f = form.toLowerCase();
    needles.add(f);
    if (form.includes(':')) continue;
    needles.add(f.slice(-8));
    for (let i = 0; i + WINDOW <= f.length; i += 1) needles.add(f.slice(i, i + WINDOW));
  }
  return [
    { rule: 'address', test: includesAny([...needles]) },
    { rule: 'address', test: shortenedProbe(forms.filter((f) => !f.includes(':'))) },
  ];
}

/** Probes for one known secret; `accounts` collects the parsed TON accounts. */
export function secretProbes(secret: SecretValue, accounts: TonAccountId[]): Probe[] {
  const value = secret.value.trim();
  const { kind } = secret;
  if (value.length < (MIN[kind] ?? 3)) return [];
  switch (kind) {
    case 'name':
    case 'secret': {
      const unified = unifyApostrophes(value);
      return [unified, ...namePieces(value), ...words(unified)]
        .flatMap(nfc)
        .map((w) => ({ rule: kind, test: wordIn(w) }));
    }
    case 'username': {
      const lower = value.toLowerCase();
      const bare = lower.replace(/[^\p{L}\p{N}_]/gu, '');
      return [
        { rule: kind, test: (v) => v.includes(lower) || (bare.length >= 5 && v.includes(bare)) },
      ];
    }
    case 'tg_id':
    case 'phone': {
      const digits = value.replace(/\D/g, '');
      if (digits.length < 5) return [];
      const probes = [{ rule: kind, test: digitsProbe(digits) }];
      if (kind === 'phone' && digits.length > 9) {
        probes.push({ rule: kind, test: digitsProbe(digits.slice(-9), true) });
      }
      return probes;
    }
    case 'address':
    case 'wallet': {
      const id = parseTonAddress(value);
      if (id === null) return [{ rule: kind, test: includesAny(pieces(value)) }];
      accounts.push(id);
      return addressProbes(id);
    }
    case 'photo': {
      const urls = value.match(/(?:https?:)?\/\/[^\s"'<>]+/g) ?? [];
      const needles = urls.map((u) => u.replace(/^https?:/, '').toLowerCase());
      return needles.length === 0 ? [] : [{ rule: kind, test: includesAny(needles) }];
    }
    case 'cookie':
      return [{ rule: kind, test: includesAny(pieces(value, COOKIE_PIECE)) }];
    default:
      return [{ rule: kind, test: includesAny(pieces(value)) }];
  }
}
