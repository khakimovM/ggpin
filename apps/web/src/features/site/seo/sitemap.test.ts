import { describe, expect, it } from 'vitest';
import { buildSitemap } from './build-sitemap';
import { indexablePages, SITE_PAGES, type SitePage } from './site-pages';

const SITE = 'https://ggpin.example';
const page = (path: SitePage['path'], indexable = true): SitePage => ({
  path,
  indexable,
  lastModified: '2026-11-11',
  changeFrequency: 'monthly',
  priority: 0.5,
});

describe('buildSitemap', () => {
  const pages = [page('/'), page('/telegram-stars'), page('/terms', false)];
  const entries = buildSitemap(SITE, pages);

  it('lists every indexable page once per language, and nothing else', () => {
    expect(entries.map((entry) => entry.url)).toEqual([
      SITE,
      `${SITE}/ru`,
      `${SITE}/telegram-stars`,
      `${SITE}/ru/telegram-stars`,
    ]);
  });

  it('keeps a draft (not indexable) page out', () => {
    expect(entries.some((entry) => entry.url.includes('terms'))).toBe(false);
  });

  it('gives each entry the full uz / ru / x-default set, and the sets of a pair agree', () => {
    for (const entry of entries) {
      const languages = entry.alternates?.languages ?? {};
      expect(Object.keys(languages).sort()).toEqual(['ru', 'uz', 'x-default']);
      for (const href of Object.values(languages)) expect(String(href)).toMatch(/^https:\/\//);
    }
    const [uzEntry, ruEntry] = entries;
    expect(uzEntry?.alternates).toEqual(ruEntry?.alternates);
    // Two-way: every language version of a page points at both, itself included.
    expect(uzEntry?.alternates?.languages).toEqual({
      uz: SITE,
      ru: `${SITE}/ru`,
      'x-default': SITE,
    });
  });

  it('never lists the private or non-web areas', () => {
    for (const path of ['/store', '/login', '/tg', '/pay', '/dev', '/api']) {
      expect(entries.some((entry) => new URL(entry.url).pathname.startsWith(path))).toBe(false);
    }
  });

  it('carries the registry data through', () => {
    expect(entries[0]).toMatchObject({
      lastModified: '2026-11-11',
      changeFrequency: 'monthly',
      priority: 0.5,
    });
  });
});

describe('the page registry', () => {
  it('has unique, rooted paths and ISO dates', () => {
    const paths = SITE_PAGES.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of SITE_PAGES) {
      expect(p.path.startsWith('/')).toBe(true);
      expect(p.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.priority).toBeGreaterThanOrEqual(0);
      expect(p.priority).toBeLessThanOrEqual(1);
    }
  });

  it('lists the home page and no area that carries noindex', () => {
    expect(SITE_PAGES.some((p) => p.path === '/')).toBe(true);
    for (const p of SITE_PAGES) expect(p.path).not.toMatch(/^\/(store|login|tg|pay|dev|api)(\/|$)/);
  });

  it('indexablePages drops drafts', () => {
    expect(indexablePages([page('/a'), page('/b', false)]).map((p) => p.path)).toEqual(['/a']);
  });
});
