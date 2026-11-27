import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Locale-aware preload of ONE headline font file (p8 S6).
//
// Why not next/font's own `preload: true`:
// - it preloads every listed subset on every page (for our two fonts that is 6 files, ~250 KB,
//   Unbounded latin-ext alone 117 KB), while a page's headlines need one or two files: uz Latin,
//   ru Cyrillic plus Latin (brand names);
// - next/font picks the files per layout module, not per locale, and `[locale]` is one layout;
// - Next 15.5's font manifest plugin matches the loader path with forward slashes, so a build made
//   on Windows emits no font preload at all (`"app":{}` in next-font-manifest.json).
// So fonts.ts sets `preload: false`, and the locale layout asks for the Unbounded files of its
// scripts here (the late Cyrillic Unbounded swap moved the RU hero h1 from 4 to 5 lines).
//
// The file names are content hashes made at build time, so they are read from the build's own CSS:
// the `@font-face` rule of the family whose `unicode-range` covers the script. If anything is not
// found, there is simply no preload (the page renders exactly as before).

export type FontScript = 'latin' | 'cyrillic';

// The range that only that subset's rule of a Google font has (latin-ext and cyrillic-ext
// differ). Compared as numbers, so the minified `u+00??` and the plain `U+0000-00FF` are the same.
const SUBSET_RANGE: Record<FontScript, readonly [number, number]> = {
  latin: [0x0000, 0x00ff],
  cyrillic: [0x0400, 0x045f],
};

/** `U+0400-045F`, `u+00??` (wildcards) or `U+2116` as [first, last]; null if malformed. */
function parseRange(raw: string): readonly [number, number] | null {
  const text = raw.replace(/\s+/g, '').toLowerCase();
  const match = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/.exec(text);
  const first = match?.[1];
  if (first === undefined) return null;
  const last = match?.[2];
  if (first.includes('?')) {
    // Wildcards stand only at the end and never combine with an explicit end.
    if (last !== undefined || !/^[0-9a-f]*\?+$/.test(first)) return null;
    return [
      Number.parseInt(first.replaceAll('?', '0'), 16),
      Number.parseInt(first.replaceAll('?', 'f'), 16),
    ];
  }
  return [Number.parseInt(first, 16), Number.parseInt(last ?? first, 16)];
}

// Only next/font's own output is ever emitted as a preload URL.
const MEDIA_URL = /^\/_next\/static\/media\/[\w.-]+\.woff2$/;

function declaration(body: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:([^;]*)`, 'i').exec(body);
  return match?.[1]?.trim() ?? null;
}

/** The woff2 URL of `family`'s `@font-face` rule for `script` in `css`, or null. */
export function findFontFile(css: string, family: string, script: FontScript): string | null {
  const wantedFamily = family.toLowerCase();
  const [wantedFirst, wantedLast] = SUBSET_RANGE[script];
  for (const rule of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = rule[1] ?? '';
    const name = declaration(body, 'font-family')?.replace(/['"]/g, '').trim().toLowerCase();
    if (name !== wantedFamily) continue;
    const ranges = (declaration(body, 'unicode-range') ?? '').split(',').map(parseRange);
    if (!ranges.some((range) => range?.[0] === wantedFirst && range[1] === wantedLast)) continue;
    const url = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i.exec(declaration(body, 'src') ?? '')?.[1];
    if (url !== undefined && MEDIA_URL.test(url)) return url;
  }
  return null;
}

function* cssFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* cssFiles(full);
    else if (entry.name.endsWith('.css')) yield full;
  }
}

// One lookup per family and script for the life of the server process (the build does not change).
// A read error is not cached: the next request tries again.
const cache = new Map<string, string | null>();

const DEFAULT_CSS_DIR = (): string => path.join(process.cwd(), '.next', 'static', 'css');

/** The error's code (`ENOENT`, ...) for the log: never its message, which holds the path. */
function reasonOf(error: unknown): string {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/**
 * The URL to preload for `family` in `script`, found in the production build's CSS
 * (`<cwd>/.next/static/css`), or null (dev, tests, no build, or no matching rule).
 */
export function fontPreloadHref(
  family: string,
  script: FontScript,
  cssDir: string = DEFAULT_CSS_DIR(),
): string | null {
  if (process.env.NODE_ENV !== 'production') return null;
  const key = `${cssDir}|${family}|${script}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  try {
    for (const file of cssFiles(cssDir)) {
      found = findFontFile(readFileSync(file, 'utf8'), family, script);
      if (found !== null) break;
    }
  } catch (error) {
    console.warn(`[font-preload] build CSS not readable: ${reasonOf(error)}`);
    return null;
  }
  cache.set(key, found);
  return found;
}
