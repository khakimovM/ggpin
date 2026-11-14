import { LOCALES } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { localizedPath } from '../../../../i18n/paths';
import { resolveSitePageUrl } from '../../../../telegram/open-link';
import { buildSitemap } from '../../seo/build-sitemap';
import { SITE_PAGES, type SitePage } from '../../seo/site-pages';
import { LEGAL_DOCS, legalDoc, type PublishedLegalDoc } from '../legal-docs';
import { legalMetadata } from '../legal-metadata';
import { legalDescription, legalSections } from '../legal-texts';

vi.mock(
  'next-intl/server',
  async () => (await import('../../shell/__tests__/intl-server-mock')).intlServerMock,
);

const SITE = 'https://ggpin.example';

const PUBLISHED: PublishedLegalDoc = {
  key: 'terms',
  path: '/terms',
  draft: false,
  updatedAt: '2026-12-01',
  sectionIds: ['general', 'payment'],
};

// A catalog with a published offer in it, for the template's reader (the real catalogs have none).
const FAKE_CATALOG = {
  site: { meta: { terms: { title: 'Ommaviy oferta', description: 'Shartlar.' } } },
  legal: {
    terms: {
      sections: {
        general: { title: 'Umumiy qoidalar', body: 'Birinchi xatboshi.\n\nIkkinchi xatboshi.' },
        payment: { title: 'To‘lov', body: '  Bitta xatboshi.  \n \n' },
      },
    },
  },
};

// `YYYY-MM-DD` and a day that exists: `2026-02-30` matches the pattern but is not a date.
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

const registryPage = (path: string): SitePage | undefined =>
  SITE_PAGES.find((page) => page.path === path);

describe('the legal documents', () => {
  it('each has its page in the site registry, of the legal kind, at its own slug', () => {
    for (const doc of LEGAL_DOCS) {
      expect(doc.path).toBe(`/${doc.key}`);
      expect(registryPage(doc.path)?.kind, doc.key).toBe('legal');
    }
    const legalPages = SITE_PAGES.filter((page) => page.kind === 'legal').map((page) => page.path);
    expect(legalPages.sort()).toEqual(LEGAL_DOCS.map((doc) => doc.path).sort());
  });

  it('a page is indexable exactly when its document is published (the registry follows `draft`)', () => {
    for (const doc of LEGAL_DOCS) {
      expect(registryPage(doc.path)?.indexable, doc.key).toBe(!doc.draft);
    }
  });

  it('the template has its own four words in both catalogs', () => {
    for (const locale of LOCALES) {
      const legal = MESSAGES[locale].legal;
      for (const key of ['contact', 'draftNotice', 'toc', 'updated'] as const) {
        expect(typeof legal[key], `${locale}:legal.${key}`).toBe('string');
      }
    }
  });

  // Each document by its own flag, so publishing one (legal-docs.ts) breaks nothing here unless the
  // catalogs, the entry and the registry disagree.
  it('a draft has no legal wording in the catalogs and no description (D-16: never stand-in text)', () => {
    for (const doc of LEGAL_DOCS) {
      if (!doc.draft) continue;
      for (const locale of LOCALES) {
        expect(Object.hasOwn(MESSAGES[locale].legal, doc.key), `${locale}:legal.${doc.key}`).toBe(
          false,
        );
        expect(legalDescription(locale, doc.key), `${locale}:${doc.key}`).toBeUndefined();
      }
    }
  });

  it.each(LOCALES)(
    '%s: a draft carries noindex and its title, and no description',
    async (locale) => {
      for (const doc of LEGAL_DOCS.filter((candidate) => candidate.draft)) {
        const meta = await legalMetadata(locale, doc);
        expect(meta.robots).toEqual({ index: false, follow: true });
        expect(meta.title).toBe(MESSAGES[locale].site.meta[doc.key].title);
        expect(meta.description).toBeUndefined();
        // The canonical and the language pair are there all the same (the page exists).
        expect(meta.alternates?.canonical).toMatch(
          new RegExp(`${localizedPath(locale, doc.path)}$`),
        );
      }
    },
  );

  it('a draft is not in the sitemap, a published document is; the same page published is', () => {
    const urls = buildSitemap(SITE).map((entry) => entry.url);
    for (const doc of LEGAL_DOCS) {
      expect(urls.includes(`${SITE}${doc.path}`), doc.key).toBe(!doc.draft);
      expect(urls.includes(`${SITE}/ru${doc.path}`), `ru:${doc.key}`).toBe(!doc.draft);
    }
    const published = SITE_PAGES.map((page) =>
      page.path === '/terms' ? { ...page, indexable: true } : page,
    );
    expect(buildSitemap(SITE, published).map((entry) => entry.url)).toEqual(
      expect.arrayContaining([`${SITE}/terms`, `${SITE}/ru/terms`]),
    );
  });

  it('a published document is indexable and has its description', async () => {
    const meta = await legalMetadata('uz', PUBLISHED);
    expect(meta).not.toHaveProperty('robots');
    expect(legalDescription('uz', 'terms', FAKE_CATALOG)).toBe('Shartlar.');
  });

  it('the Mini App may open exactly the legal pages, in both languages, and nothing more of the site', () => {
    for (const locale of LOCALES) {
      for (const doc of LEGAL_DOCS) {
        expect(
          resolveSitePageUrl(localizedPath(locale, doc.path)),
          `${locale}${doc.path}`,
        ).not.toBeNull();
      }
      for (const page of SITE_PAGES.filter((candidate) => candidate.kind !== 'legal')) {
        expect(resolveSitePageUrl(localizedPath(locale, page.path)), page.path).toBeNull();
      }
    }
  });

  it('the effective-date check takes only a real YYYY-MM-DD day', () => {
    expect(isCalendarDay(PUBLISHED.updatedAt)).toBe(true);
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-1-01',
      '01.12.2026',
      '2026-12-01T00:00',
      '',
    ]) {
      expect(isCalendarDay(bad), bad).toBe(false);
    }
  });

  it('looks a document up by its key', () => {
    expect(legalDoc('privacy').path).toBe('/privacy');
  });
});

describe('legalSections (the published template reads the lawyer’s text from the catalogs)', () => {
  it('numbers the sections in order and splits a body at blank lines', () => {
    expect(legalSections('uz', PUBLISHED, FAKE_CATALOG)).toEqual([
      {
        id: 'general',
        number: 1,
        title: 'Umumiy qoidalar',
        paragraphs: ['Birinchi xatboshi.', 'Ikkinchi xatboshi.'],
      },
      { id: 'payment', number: 2, title: 'To‘lov', paragraphs: ['Bitta xatboshi.'] },
    ]);
  });

  it('throws for a section without its text, rather than render half a document', () => {
    const missing: PublishedLegalDoc = { ...PUBLISHED, sectionIds: ['general', 'refunds'] };
    expect(() => legalSections('ru', missing, FAKE_CATALOG)).toThrow(
      'legal text missing: ru:legal.terms.sections.refunds',
    );
  });

  it('every published document has all its sections in both languages, with anchor-safe ids', () => {
    for (const doc of LEGAL_DOCS) {
      if (doc.draft) continue;
      expect(isCalendarDay(doc.updatedAt), `${doc.key}.updatedAt`).toBe(true);
      expect(new Set(doc.sectionIds).size).toBe(doc.sectionIds.length);
      for (const id of doc.sectionIds) expect(id).toMatch(/^[a-z0-9-]+$/);
      for (const locale of LOCALES) {
        expect(() => legalSections(locale, doc)).not.toThrow();
        expect(legalDescription(locale, doc.key), `${locale}:${doc.key}`).toBeDefined();
      }
    }
  });
});
