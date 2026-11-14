import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findFontFile, fontPreloadHref } from '../font-preload';

// The shape next/font writes into the production CSS (minified, one rule per subset).
const CSS = [
  '@font-face{font-family:Manrope;font-style:normal;font-weight:200 800;font-display:swap;src:url(/_next/static/media/86f65e8637cc94e3-s.woff2) format("woff2");unicode-range:u+0301,u+0400-045f,u+0490-0491,u+04b0-04b1,u+2116}',
  '@font-face{font-family:Unbounded;font-style:normal;font-weight:200 900;font-display:swap;src:url(/_next/static/media/e546cf32c9d4702c-s.woff2) format("woff2");unicode-range:u+0460-052f,u+1c80-1c8a,u+20b4,u+2de0-2dff,u+a640-a69f,u+fe2e-fe2f}',
  '@font-face{font-family:Unbounded;font-style:normal;font-weight:200 900;font-display:swap;src:url(/_next/static/media/d76fe899475ae4d7-s.woff2) format("woff2");unicode-range:u+0301,u+0400-045f,u+0490-0491,u+04b0-04b1,u+2116}',
  '@font-face{font-family:Unbounded;font-style:normal;font-weight:200 900;font-display:swap;src:url(/_next/static/media/87bc17f7c8b98e48-s.woff2) format("woff2");unicode-range:u+0100-02ba,u+02bd-02c5,u+1e00-1e9f}',
  '@font-face{font-family:Unbounded;font-style:normal;font-weight:200 900;font-display:swap;src:url(/_next/static/media/29b98dbfba401fa9-s.woff2) format("woff2");unicode-range:u+00??,u+0131,u+0152-0153,u+02bb-02bc,u+2000-206f}',
  '@font-face{font-family:Unbounded Fallback;src:local("Arial");ascent-override:73.93%;size-adjust:134.59%}',
].join('');

describe('findFontFile', () => {
  it('finds the Cyrillic rule, not cyrillic-ext and not the other family', () => {
    expect(findFontFile(CSS, 'Unbounded', 'cyrillic')).toBe(
      '/_next/static/media/d76fe899475ae4d7-s.woff2',
    );
  });

  it('finds the Latin rule (the one with the Uzbek ‘ and ʼ), not latin-ext', () => {
    expect(findFontFile(CSS, 'Unbounded', 'latin')).toBe(
      '/_next/static/media/29b98dbfba401fa9-s.woff2',
    );
  });

  it('accepts a quoted family name and is case-insensitive', () => {
    const quoted = CSS.replaceAll('font-family:Unbounded;', 'font-family:"UNBOUNDED";');
    expect(findFontFile(quoted, 'Unbounded', 'cyrillic')).toBe(
      '/_next/static/media/d76fe899475ae4d7-s.woff2',
    );
  });

  it('reads the plain (not minified) ranges too, in any case and spacing', () => {
    const plain = CSS.replaceAll(
      'unicode-range:u+00??,',
      'unicode-range: U+0000-00FF , ',
    ).replaceAll('unicode-range:u+0301,u+0400-045f,', 'unicode-range:U+0301, u+0400 - 045F,');
    expect(findFontFile(plain, 'Unbounded', 'latin')).toBe(
      '/_next/static/media/29b98dbfba401fa9-s.woff2',
    );
    expect(findFontFile(plain, 'Unbounded', 'cyrillic')).toBe(
      '/_next/static/media/d76fe899475ae4d7-s.woff2',
    );
  });

  it('does not take a wider or a malformed range for the subset', () => {
    const wider = CSS.replaceAll('unicode-range:u+00??,', 'unicode-range:u+0???,').replaceAll(
      'u+0400-045f',
      'u+04zz-045f',
    );
    expect(findFontFile(wider, 'Unbounded', 'latin')).toBeNull();
    expect(findFontFile(wider, 'Unbounded', 'cyrillic')).toBeNull();
  });

  it('returns null without a matching rule', () => {
    expect(findFontFile(CSS, 'Inter', 'latin')).toBeNull();
    expect(findFontFile('', 'Unbounded', 'latin')).toBeNull();
  });

  it('never returns a URL outside next/font media files', () => {
    const foreign = CSS.replaceAll('/_next/static/media/', 'https://evil.example/');
    expect(findFontFile(foreign, 'Unbounded', 'cyrillic')).toBeNull();
  });
});

describe('fontPreloadHref', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is off outside a production server (tests, dev)', () => {
    expect(fontPreloadHref('Unbounded', 'cyrillic')).toBeNull();
  });

  it('finds the file in the build CSS and keeps the answer', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const dir = mkdtempSync(path.join(tmpdir(), 'font-preload-'));
    try {
      writeFileSync(path.join(dir, 'a.css'), CSS);
      expect(fontPreloadHref('Unbounded', 'latin', dir)).toBe(
        '/_next/static/media/29b98dbfba401fa9-s.woff2',
      );
      rmSync(path.join(dir, 'a.css'));
      // Cached: the build does not change while the server runs.
      expect(fontPreloadHref('Unbounded', 'latin', dir)).toBe(
        '/_next/static/media/29b98dbfba401fa9-s.woff2',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not cache a read error, and warns once per failure without the path', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = path.join(tmpdir(), `font-preload-missing-${Date.now()}`);
    expect(fontPreloadHref('Unbounded', 'cyrillic', dir)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[font-preload] build CSS not readable: ENOENT');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(dir);

    // The build appears: the next request finds the file (nothing stale was cached).
    mkdirSync(dir);
    try {
      writeFileSync(path.join(dir, 'a.css'), CSS);
      expect(fontPreloadHref('Unbounded', 'cyrillic', dir)).toBe(
        '/_next/static/media/d76fe899475ae4d7-s.woff2',
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
