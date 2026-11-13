import { describe, expect, it } from 'vitest';
import type { SitePage } from '../../seo/site-pages';
import { FOOTER_INFO_LINKS, FOOTER_PRODUCT_LINKS, linksToExistingPages } from '../footer-links';
import { yearInDisplayZone } from '../current-year';

// The footer does not read a page's kind; every test page is given one.
const page = (path: SitePage['path'], indexable = true): SitePage => ({
  path,
  kind: 'product',
  indexable,
  lastModified: '2026-11-12',
  changeFrequency: 'monthly',
  priority: 0.5,
});

describe('linksToExistingPages', () => {
  it('draws only the pages that are in the registry', () => {
    const registry = [page('/'), page('/telegram-stars'), page('/faq')];
    expect(linksToExistingPages(FOOTER_PRODUCT_LINKS, registry).map((l) => l.path)).toEqual([
      '/telegram-stars',
    ]);
    expect(linksToExistingPages(FOOTER_INFO_LINKS, registry).map((l) => l.path)).toEqual(['/faq']);
  });

  it('a page that exists but is not indexed (a draft) still gets its link', () => {
    const registry = [page('/terms', false)];
    expect(linksToExistingPages(FOOTER_INFO_LINKS, registry).map((l) => l.path)).toEqual([
      '/terms',
    ]);
  });

  it('an empty registry gives no links at all', () => {
    expect(linksToExistingPages(FOOTER_PRODUCT_LINKS, [])).toEqual([]);
    expect(linksToExistingPages(FOOTER_INFO_LINKS, [])).toEqual([]);
  });

  it('keeps the order the footer wants, not the registry order', () => {
    const registry = [page('/contacts'), page('/faq'), page('/privacy')];
    expect(linksToExistingPages(FOOTER_INFO_LINKS, registry).map((l) => l.path)).toEqual([
      '/faq',
      '/privacy',
      '/contacts',
    ]);
  });
});

describe('yearInDisplayZone', () => {
  it('is the year in Uzbekistan: 20:00 UTC on 31 December is already the new year there', () => {
    expect(yearInDisplayZone(new Date('2025-12-31T20:00:00Z'))).toBe('2026');
    expect(yearInDisplayZone(new Date('2025-12-31T18:59:00Z'))).toBe('2025');
  });
});
