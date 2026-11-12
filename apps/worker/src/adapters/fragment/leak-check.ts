import { secretProbes, type Probe } from './leak-probes';
import { allViews, unifyApostrophes } from './leak-views';
import type { SecretValue } from './secret-forms';
import { containsAtAnyBitShift, parseTonAddress, type TonAccountId } from './ton-address-forms';

// The last gate before a fixture is written (S-1). It does not use the sanitizer's rules: it
// decodes the text every way it can (leak-views.ts) and looks for each secret and its parts
// (leak-probes.ts), plus generic shapes: cookie pairs, the API hash, photo hosts, e-mails,
// phone numbers, long hex, and any TON address that is not Fragment's (also one glued to other
// base64 or broken over lines, R-6). It returns rule names only, never values.

export interface LeakCheckInput {
  readonly secrets: readonly SecretValue[];
  readonly keepAddresses: readonly string[];
}

export type LeakCheck = (text: string) => string[];

/** A bare Uzbek mobile number (`901234567`) right after a phone word (F-3); views are lower case. */
const PHONE_CONTEXT_9 =
  /(?<=(?:tel|phone|mobile|телефон|номер|raqam)[^\d<>"]{0,12})(?<!\d)9\d{8}(?!\d)/;

const GENERIC: Probe[] = [
  {
    rule: 'cookie-pair',
    // The shapes the sanitizer's cookie rule redacts (F-7): `stel_x=value`, `"stel_x": "value"`;
    // JS like `'stel_dt='+offset` has no value after `=`. Known cookies have their own probes.
    test: (v) =>
      /stel_[a-z_]+=(?!<redacted)[^\s;"'<>&,\\]{4,}/.test(v) ||
      /"stel_[a-z_]+"\s*:\s*"(?!<redacted)[^"]{4,}/.test(v),
  },
  // `hash=` as its own word (F-7: `infohash=` is not the API hash; the real one is known).
  { rule: 'api-hash', test: (v) => /(?<![a-z0-9_])hash=(?!<redacted)[0-9a-f]{6,}/.test(v) },
  {
    rule: 'photo-url',
    // A base64 image only (F-7): an inline `data:image/svg+xml,%3Csvg…` is page decoration.
    test: (v) =>
      /telesco\.pe|telegram-cdn\.org|cdn-telegram\.org|\/userpic|data:image\/[a-z0-9.+-]+;base64,/.test(
        v,
      ),
  },
  {
    // A shortened TON address (F-4): `UQAB…wxyz`, `UQAB … wxyz`, `UQABcd***uvwxyz`.
    rule: 'short-address',
    test: (v) =>
      /(?<![a-z0-9_-])[euk0][qf][a-z0-9_-]{2,6}\s*(?:…|\.\.\.?|\*{2,})\s*[a-z0-9_-]{4,8}(?![a-z0-9_-])/.test(
        v,
      ),
  },
  {
    rule: 'email',
    test: (v) => /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/.test(v),
  },
  {
    rule: 'phone-shape',
    test: (v) =>
      /(?<![\w+])\+\d[\d\s().-]{7,18}\d(?!\d)/.test(v) ||
      /(?<!\d)998[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/.test(v) ||
      /(?<!\d)8\s?\(\d{3}\)\s?\d{3}-?\d{2}-?\d{2}(?!\d)/.test(v) ||
      /(?<![\d+])\d{2} \d{3} \d{2} \d{2}(?!\d)/.test(v) ||
      /(?<![\d-])\d{2}-\d{3}-\d{2}-\d{2}(?![\d-])/.test(v) ||
      PHONE_CONTEXT_9.test(v),
  },
];

const B64_48 = /[A-Za-z0-9+/_-]{48,}/g;

export function createLeakCheck(input: LeakCheckInput): LeakCheck {
  const accounts: TonAccountId[] = [];
  const probes = [...input.secrets.flatMap((s) => secretProbes(s, accounts)), ...GENERIC];
  // Kept: only Fragment's pay address, in the exact spelling given, never a secret account (R-4).
  const keep = input.keepAddresses.filter((a) => {
    const id = parseTonAddress(a);
    return id !== null && !accounts.some((s) => s.hash.equals(id.hash));
  });
  const keepSet = new Set(keep);
  const keepRaw = new Set(
    keep.filter((k) => k.includes(':')).map((k) => (k.split(':')[1] ?? '').toLowerCase()),
  );

  const foreignAddress = (view: string): boolean => {
    for (const m of view.matchAll(B64_48)) {
      const run = m[0];
      // Every 48-character window: an address glued to other base64 is still found (N9).
      for (let i = 0; i + 48 <= run.length; i += 1) {
        const window = run.slice(i, i + 48);
        if (parseTonAddress(window) !== null && !keepSet.has(window)) return true;
      }
    }
    for (const m of view.matchAll(/:([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)) {
      if (!keepRaw.has((m[1] ?? '').toLowerCase())) return true;
    }
    return false;
  };
  const longHex = (view: string): boolean => {
    for (const m of view.matchAll(/(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi)) {
      const hex = m[0];
      if (hex.length === 64 && keepRaw.has(hex.toLowerCase())) continue;
      return true;
    }
    return false;
  };

  return (text) => {
    const found = new Set<string>();
    const views = allViews(text);
    const lowered = [
      ...new Set(
        [...views.text, ...views.decoded].flatMap((v) => {
          const lower = v.toLowerCase();
          return [lower, unifyApostrophes(lower)];
        }),
      ),
    ];
    for (const probe of probes) if (lowered.some(probe.test)) found.add(probe.rule);
    if (views.text.some(foreignAddress)) found.add('ton-address');
    if (views.text.some(longHex)) found.add('hex-token');
    for (const bytes of views.bytes) {
      if (accounts.some((a) => containsAtAnyBitShift(bytes, a.hash))) found.add('address-bytes');
    }
    return [...found].sort();
  };
}
