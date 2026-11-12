import { secretProbes, type Probe } from './leak-probes';
import { allViews, loweredViews } from './leak-views';
import type { SecretValue } from './secret-forms';
import { COOKIE_SHAPES, HASH_SHAPE, PHONE_SHAPES, PHOTO_DATA, hasShape } from './secret-shapes';
import { containsAtAnyBitShift, parseTonAddress, type TonAccountId } from './ton-address-forms';

// The last gate before a fixture is written (S-1). It decodes the text every way it can
// (leak-views.ts) and looks for each known secret and its parts (leak-probes.ts): that part never
// uses the sanitizer's patterns. The generic shapes of a value it does not know (cookie pairs, the
// API hash, a base64 image, phone numbers) come from secret-shapes.ts, the SAME expressions the
// sanitizer redacts with (F-7, round 4 I-1), run here on every decoded view; photo hosts, e-mails,
// shortened and foreign TON addresses and long hex are its own. It returns rule names only.

export interface LeakCheckInput {
  readonly secrets: readonly SecretValue[];
  readonly keepAddresses: readonly string[];
}

export type LeakCheck = (text: string) => string[];

/**
 * A shape whose secret group (2) has 4+ characters and ends where a value ends (a separator or
 * the end), as the audit's tested expression: `'stel_dt='+encodeURIComponent(` in a view without
 * the `+` is JS, not a cookie (F-7).
 */
const shapeWithValue =
  (re: RegExp) =>
  (view: string): boolean =>
    [...view.matchAll(re)].some((m) => {
      const end = view.charAt((m.index ?? 0) + m[0].length);
      return (m[2] ?? '').length >= 4 && (end === '' || /[\s;"'<>&,\\]/.test(end));
    });

const GENERIC: Probe[] = [
  { rule: 'cookie-pair', test: (v) => COOKIE_SHAPES.some((re) => shapeWithValue(re)(v)) },
  { rule: 'api-hash', test: (v) => hasShape(HASH_SHAPE, v) },
  {
    rule: 'photo-url',
    test: (v) =>
      /telesco\.pe|telegram-cdn\.org|cdn-telegram\.org|\/userpic/.test(v) ||
      hasShape(PHOTO_DATA, v),
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
  { rule: 'phone-shape', test: (v) => PHONE_SHAPES.some((re) => hasShape(re, v)) },
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
    const lowered = loweredViews(views);
    for (const probe of probes) if (lowered.some(probe.test)) found.add(probe.rule);
    if (views.text.some(foreignAddress)) found.add('ton-address');
    if (views.text.some(longHex)) found.add('hex-token');
    for (const bytes of views.bytes) {
      if (accounts.some((a) => containsAtAnyBitShift(bytes, a.hash))) found.add('address-bytes');
    }
    return [...found].sort();
  };
}
