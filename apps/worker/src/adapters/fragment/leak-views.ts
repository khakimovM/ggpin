// Decoded views of a text for the leak check (S-1, R-6). Written separately from the sanitizer on
// purpose: the check must not share the sanitizer's assumptions. It decodes URL escapes (several
// layers), HTML entities (decimal, hex, named, also without `;`), JSON escapes (\uXXXX, \/), `+`
// as a space; adds NFKC/NFC/NFD forms and copies without tags or zero-width characters; and
// decodes every base64 run of 8+ characters (at four offsets, also wrapped over lines), whose
// bytes get the same views again (two levels deep).

function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function urlDecodeOnce(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return Buffer.from(run.replace(/%/g, ''), 'hex').toString('latin1');
    }
  });
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
  wbr: '',
  equals: '=',
  colon: ':',
};

function htmlDecode(text: string): string {
  return text
    .replace(/&#(\d{1,7});?/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]{1,6});?/g, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

const BS = String.fromCharCode(92);

function jsonUnescape(text: string): string {
  return (
    text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
      // JS escapes too (I-2): `\x66`, `\u{1F3AE}`.
      .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h: string) => codePoint(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/\\[nrt]/g, ' ')
      .split(`${BS}${BS}`)
      .join(BS)
  );
}

const ch = (...codes: number[]): string => String.fromCharCode(...codes);
const APOSTROPHE_LOOKALIKES = new RegExp(
  `[${ch(0x60, 0xb4, 0x2018, 0x2019, 0x2b9, 0x2bb, 0x2bc, 0xa78c)}]`,
  'g',
);

/** Every apostrophe look-alike as `'` (F-2), on both the secret and the views. */
export function unifyApostrophes(text: string): string {
  return text.replace(APOSTROPHE_LOOKALIKES, "'");
}

const INVISIBLE = new RegExp(`[${ch(0x200b)}-${ch(0x200f)}${ch(0xad, 0x2060, 0xfeff)}]`, 'g');

/** Copies a reader would see as the same text: normalized, without tags or invisible marks. */
function looksSame(view: string): string[] {
  const out = new Set<string>();
  for (const form of [view, view.normalize('NFKC'), view.normalize('NFC'), view.normalize('NFD')]) {
    out.add(form);
    out.add(form.replace(/\s+/g, ' '));
    const plain = form.replace(/<[^>]*>/g, '').replace(INVISIBLE, '');
    out.add(plain);
    out.add(plain.replace(/\s+/g, ''));
  }
  return [...out];
}

/** Text views: as is, and fully decoded (with and without `+` as a space), layer by layer. */
export function textViews(text: string): string[] {
  const layers = new Set<string>([text]);
  for (const plusIsSpace of [false, true]) {
    let current = plusIsSpace ? text.replace(/\+/g, ' ') : text;
    layers.add(current);
    for (let round = 0; round < 6; round += 1) {
      const next = jsonUnescape(htmlDecode(urlDecodeOnce(current)));
      if (next === current) break;
      layers.add(next);
      current = next;
    }
  }
  const views = new Set<string>();
  for (const layer of layers) for (const view of looksSame(layer)) views.add(view);
  return [...views];
}

const B64_RUN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;
const MIN_RUN = 8;

/** Every base64 run of 8+ characters (line breaks and spaces removed), decoded at 4 offsets. */
export function decodedRuns(views: readonly string[]): Buffer[] {
  const seen = new Set<string>();
  const out: Buffer[] = [];
  const add = (candidate: string): void => {
    if (candidate.length < MIN_RUN || seen.has(candidate)) return;
    seen.add(candidate);
    for (let offset = 0; offset < 4; offset += 1) {
      out.push(
        Buffer.from(candidate.slice(offset).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      );
    }
  };
  for (const view of views) {
    for (const source of [view, view.replace(/\\[nr]|\s/g, '')]) {
      for (const match of source.matchAll(B64_RUN)) {
        add(match[0]);
        // A run can hold a URL path: also try every piece after a separator.
        for (const piece of match[0].split(/[/=]/)) add(piece);
      }
    }
  }
  return out;
}

const strip = (s: string): string =>
  [...s].filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '\u007f').join('');

/** Text forms of decoded bytes: latin1, utf8, and both without control characters. */
export function bytesViews(bytes: Buffer): string[] {
  const latin1 = bytes.toString('latin1');
  const utf8 = bytes.toString('utf8');
  return [latin1, utf8, strip(latin1), strip(utf8)];
}

export interface AllViews {
  /** Decoded text views (no base64). */
  readonly text: string[];
  /** Views of base64-decoded bytes (and their own decoded views, two levels deep). */
  readonly decoded: string[];
  /** The raw decoded bytes of every base64 run (first level). */
  readonly bytes: Buffer[];
}

/** Mostly readable text: worth decoding again (garbage from random words is not). */
function readable(view: string): boolean {
  if (view.length < 3) return false;
  let good = 0;
  for (const ch of view) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x20 && code < 0x7f) || (code > 0xbf && code !== 0xfffd)) good += 1;
  }
  return good >= view.length * 0.85;
}

/** Every view the leak check searches (R-6). */
export function allViews(text: string): AllViews {
  const views = textViews(text);
  const bytes = decodedRuns(views);
  const decoded = new Set<string>();
  let level = bytes;
  for (let depth = 0; depth < 2 && level.length > 0; depth += 1) {
    const next: Buffer[] = [];
    for (const buffer of level) {
      for (const view of bytesViews(buffer)) {
        if (view.length < 3) continue;
        decoded.add(view);
        if (!readable(view)) continue;
        const nested = textViews(view);
        for (const v of nested) decoded.add(v);
        if (depth === 0) next.push(...decodedRuns(nested.slice(0, 2)));
      }
    }
    level = next;
  }
  return { text: views, decoded: [...decoded], bytes };
}

/** The views the probes run on: text and decoded views, lower-cased, also apostrophes unified. */
export function loweredViews(views: AllViews): string[] {
  return [
    ...new Set(
      [...views.text, ...views.decoded].flatMap((v) => {
        const lower = v.toLowerCase();
        return [lower, unifyApostrophes(lower)];
      }),
    ),
  ];
}
