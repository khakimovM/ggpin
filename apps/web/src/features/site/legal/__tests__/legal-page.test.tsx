import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { settleServerTree } from '../../landing/__tests__/render-server';
import { legalDoc, type PublishedLegalDoc } from '../legal-docs';
import { LegalPage } from '../LegalPage';

vi.mock(
  'next-intl/server',
  async () => (await import('../../shell/__tests__/intl-server-mock')).intlServerMock,
);
vi.mock('../../../../csp/request-nonce', () => ({ requestNonce: () => Promise.resolve('n0nce') }));
// The real catalogs hold no legal text yet (the documents are drafts): the published template is
// drawn with two sections of test text.
vi.mock('../legal-texts', () => ({
  legalSections: () => [
    { id: 'general', number: 1, title: 'Umumiy qoidalar', paragraphs: ['Birinchi.', 'Ikkinchi.'] },
    { id: 'payment', number: 2, title: 'To‘lov', paragraphs: ['Uchinchi.'] },
  ],
  legalDescription: () => undefined,
}));

const draw = async (locale: 'uz' | 'ru', doc = legalDoc('terms')) =>
  render(await settleServerTree(LegalPage({ locale, doc })));

const jsonLd = (container: HTMLElement) =>
  [...container.querySelectorAll('script[type="application/ld+json"]')].map(
    (script) => JSON.parse(script.textContent ?? 'null') as Record<string, unknown>,
  );

describe.each(['uz', 'ru'] as const)('a legal page (%s)', (locale) => {
  const copy = MESSAGES[locale];
  const prefix = locale === 'uz' ? '' : '/ru';

  it.each(['terms', 'privacy'] as const)(
    'draft %s: the title, "being prepared" and the way to the contacts, nothing else',
    async (key) => {
      const { container } = await draw(locale, legalDoc(key));
      const main = within(screen.getByRole('main'));
      expect(main.getByRole('heading', { level: 1 })).toHaveTextContent(copy.site.meta[key].title);
      expect(main.getByText(copy.legal.draftNotice)).toBeInTheDocument();
      expect(main.getByRole('link', { name: copy.legal.contact })).toHaveAttribute(
        'href',
        `${prefix}/contacts`,
      );
      // One heading, one sentence, one link: no table of contents, no sections, no structured data.
      expect(main.getAllByRole('heading')).toHaveLength(1);
      expect(main.getAllByRole('link')).toHaveLength(1);
      expect(main.queryByText(copy.legal.toc)).toBeNull();
      expect(jsonLd(container)).toEqual([]);
    },
  );

  it('published: the trail, the title, the date it takes effect, the contents and the numbered sections', async () => {
    const doc: PublishedLegalDoc = {
      key: 'terms',
      path: '/terms',
      draft: false,
      updatedAt: '2026-12-01',
      sectionIds: ['general', 'payment'],
    };
    const { container } = await draw(locale, doc);
    const title = copy.site.meta.terms.title;
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title);
    // The day it takes effect, with its year, in the page's language.
    const day = locale === 'uz' ? '1-dekabr, 2026' : String.raw`1 декабря 2026\sг\.`;
    expect(screen.getByRole('main')).toHaveTextContent(
      new RegExp(copy.legal.updated.replace('{date}', day)),
    );

    const toc = screen.getByRole('navigation', { name: copy.legal.toc });
    const entries = within(toc).getAllByRole('link');
    expect(entries.map((link) => link.getAttribute('href'))).toEqual([
      '#section-general',
      '#section-payment',
    ]);
    expect(entries.map((link) => link.textContent)).toEqual(['1. Umumiy qoidalar', '2. To‘lov']);
    const sections = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(sections).toEqual([copy.legal.toc, '1. Umumiy qoidalar', '2. To‘lov']);
    expect(container.querySelector('#section-general')?.querySelectorAll('p')).toHaveLength(2);

    const trail = screen.getByRole('navigation', {
      name: copy.site.product.common.breadcrumb.label,
    });
    expect(within(trail).getByRole('link')).toHaveAttribute('href', prefix === '' ? '/' : prefix);
    expect(jsonLd(container).map((doc) => doc['@type'])).toEqual(['BreadcrumbList']);
  });
});
