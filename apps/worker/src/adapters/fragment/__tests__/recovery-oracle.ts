// A test-only copy of the re-audit oracle: a far more aggressive "can a human recover it?"
// Used only to decide whether a secret (or a part of it) is still present in a staged text.
const ENT: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
};
const cp = (n: number): string =>
  Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
function urlDec(t: string): string {
  return t.replace(/(?:%[0-9A-Fa-f]{2})+/g, (r) => {
    try {
      return decodeURIComponent(r);
    } catch {
      return Buffer.from(r.replace(/%/g, ''), 'hex').toString('latin1');
    }
  });
}
function htmlDec(t: string): string {
  return t
    .replace(/&#(\d{1,7});?/g, (_m, d: string) => cp(Number(d)))
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, h: string) => cp(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENT[n.toLowerCase()] ?? m);
}
function jsonUnesc(t: string): string {
  return t
    .replace(/[\x5c]u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[\x5c](.)/g, '$1');
}
function layers(t: string): string[] {
  const out = new Set<string>([t]);
  let cur = t;
  for (let i = 0; i < 6; i += 1) {
    const n = jsonUnesc(htmlDec(urlDec(cur)));
    if (n === cur) break;
    out.add(n);
    cur = n;
  }
  let plus = t.replace(/\+/g, ' ');
  for (let i = 0; i < 6; i += 1) {
    const n = jsonUnesc(htmlDec(urlDec(plus)));
    out.add(n);
    if (n === plus) break;
    plus = n;
  }
  return [...out];
}
function b64Pieces(t: string): Buffer[] {
  const out: Buffer[] = [];
  const joined = t.replace(/[\x5c][nr]|\s/g, '');
  for (const m of joined.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) {
    const s = m[0];
    for (let off = 0; off < 4; off += 1)
      out.push(Buffer.from(s.slice(off).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  }
  return out;
}
const strip = (s: string): string =>
  [...s].filter((c) => c.charCodeAt(0) >= 0x20 && c !== '\u007f').join('');
export function views(text: string, depth = 0): string[] {
  const base = layers(text);
  const all = new Set<string>();
  for (const v of base) {
    for (const w of [v, v.normalize('NFKC'), v.normalize('NFC')]) {
      all.add(w);
      all.add(w.replace(/<[^>]*>/g, ''));
      all.add(w.replace(/[\u200b-\u200f\u00ad\u2060\ufeff]/g, ''));
      all.add(w.replace(/[^\p{L}\p{N}_]/gu, ''));
    }
  }
  if (depth < 2) {
    for (const v of base)
      for (const b of b64Pieces(v)) {
        for (const s of [b.toString('latin1'), b.toString('utf8')])
          for (const x of views(strip(s), depth + 1)) all.add(x);
      }
  }
  return [...all];
}
export function recoverable(text: string, needle: string): boolean {
  const n = needle.toLowerCase().normalize('NFKC');
  const nStripped = n.replace(/[^\p{L}\p{N}_]/gu, '');
  return views(text).some((v) => {
    const l = v.toLowerCase();
    return l.includes(n) || (nStripped.length >= 5 && l.includes(nStripped));
  });
}
