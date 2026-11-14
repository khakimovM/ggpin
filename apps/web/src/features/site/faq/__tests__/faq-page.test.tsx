import { BRAND } from '@repo/shared';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { settleServerTree } from '../../landing/__tests__/render-server';
import { LANDING_FAQ_IDS } from '../../landing/faq-items';
import type { SiteLinks } from '../../shell/site-links';
import { FAQ_PAGE, getFaqPageItems, HELP_ASKED_ON_LANDING, HELP_FAQ_IDS } from '../faq-page';
import { FaqPage } from '../FaqPage';

vi.mock(
  'next-intl/server',
  async () => (await import('../../shell/__tests__/intl-server-mock')).intlServerMock,
);
vi.mock('../../../../csp/request-nonce', () => ({ requestNonce: () => Promise.resolve('n0nce') }));

const links = vi.hoisted((): { value: SiteLinks } => ({
  value: { bot: null, botHandle: null, channel: null, support: null },
}));
vi.mock('../../shell/site-links', () => ({ siteLinks: () => links.value }));

beforeEach(() => {
  links.value = { bot: null, botHandle: null, channel: null, support: null };
});

const jsonLd = (container: HTMLElement) =>
  [...container.querySelectorAll('script[type="application/ld+json"]')].map(
    (script) => JSON.parse(script.textContent ?? 'null') as Record<string, unknown>,
  );

describe('the questions of the FAQ page (landing + help screen, each once)', () => {
  it('takes every landing question once', () => {
    const landing = FAQ_PAGE.filter((source) => source.from === 'landing').map((s) => s.id);
    expect([...landing].sort()).toEqual([...LANDING_FAQ_IDS].sort());
  });

  it('takes every help question once, unless the landing already asks it', () => {
    const help = FAQ_PAGE.filter((source) => source.from === 'help').map((s) => s.id);
    expect(new Set(help).size).toBe(help.length);
    for (const id of HELP_FAQ_IDS) {
      const askedOnLanding = HELP_ASKED_ON_LANDING[id] !== undefined;
      expect(help.includes(id), `help q${id}`).toBe(!askedOnLanding);
    }
    // The landing question that stands for a merged help question is on the page.
    for (const landingId of Object.values(HELP_ASKED_ON_LANDING)) {
      expect(FAQ_PAGE).toContainEqual({ from: 'landing', id: landingId });
    }
    expect(FAQ_PAGE).toHaveLength(
      LANDING_FAQ_IDS.length + HELP_FAQ_IDS.length - Object.keys(HELP_ASKED_ON_LANDING).length,
    );
  });

  it('knows every help question of the catalogs (a new one must be placed or merged)', () => {
    for (const locale of ['uz', 'ru'] as const) {
      const keys = Object.keys(MESSAGES[locale].account.help.faq).filter((key) =>
        key.startsWith('q'),
      );
      expect(keys.map((key) => key.slice(1)).sort()).toEqual([...HELP_FAQ_IDS].sort());
    }
  });

  it.each(['uz', 'ru'] as const)(
    '%s: no question twice, no placeholder left, the brand from the brand module',
    async (locale) => {
      const items = await getFaqPageItems(locale);
      expect(items).toHaveLength(8);
      const questions = items.map((item) => item.question.trim().toLowerCase());
      expect(new Set(questions).size).toBe(questions.length);
      for (const item of items) {
        expect(item.question).not.toBe('');
        expect(item.answer).not.toMatch(/[{}]/);
      }
      expect(items.some((item) => item.answer.includes(BRAND.name))).toBe(true);
    },
  );
});

describe.each(['uz', 'ru'] as const)('the FAQ page (%s)', (locale) => {
  const copy = MESSAGES[locale].site;
  const prefix = locale === 'uz' ? '' : '/ru';

  it('the title, the lead, every question in an accordion with the first open, and the trail', async () => {
    const { container } = render(await settleServerTree(await FaqPage({ locale })));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.meta.faq.title);
    expect(screen.getByText(copy.faq.lead)).toBeInTheDocument();
    const items = container.querySelectorAll('main details');
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveAttribute('open');
    expect(items[1]).not.toHaveAttribute('open');
    // Its own group: the landing's accordion and this one never close each other.
    expect(items[0]).toHaveAttribute('name', 'faq-page');
    // The questions are the page's h2s, right under its h1: no heading level is skipped.
    const questions = (await getFaqPageItems(locale)).map((item) => item.question);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(
      questions,
    );
    expect(screen.queryAllByRole('heading', { level: 3 })).toEqual([]);
    const trail = screen.getByRole('navigation', { name: copy.product.common.breadcrumb.label });
    expect(within(trail).getByRole('link')).toHaveAttribute('href', prefix === '' ? '/' : prefix);
    expect(within(trail).getByText(copy.meta.faq.title)).toHaveAttribute('aria-current', 'page');
  });

  it('structured data: the trail and FAQPage with the same questions, with the nonce', async () => {
    const { container } = render(await settleServerTree(await FaqPage({ locale })));
    const blocks = jsonLd(container);
    expect(blocks.map((block) => block['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
    const questions = (blocks[1]?.['mainEntity'] ?? []) as { name: string }[];
    const items = await getFaqPageItems(locale);
    expect(questions.map((question) => question.name)).toEqual(items.map((item) => item.question));
    for (const script of container.querySelectorAll('script')) {
      expect(script.getAttribute('nonce')).toBe('n0nce');
    }
  });

  it('no support link configured: the lead leads to the contacts page instead, in the same tab', async () => {
    render(await settleServerTree(await FaqPage({ locale })));
    expect(screen.queryByRole('link', { name: copy.faq.support })).toBeNull();
    const contacts = screen.getByRole('link', { name: copy.footer.infoLinks.contacts });
    expect(contacts).toHaveAttribute('href', `${prefix}/contacts`);
    expect(contacts).not.toHaveAttribute('target');
  });

  it('the support button when a support link is configured, and then no contacts link', async () => {
    links.value = { ...links.value, support: 'https://t.me/test_support' };
    render(await settleServerTree(await FaqPage({ locale })));
    const support = screen.getByRole('link', { name: copy.faq.support });
    expect(support).toHaveAttribute('href', 'https://t.me/test_support');
    expect(support).toHaveAttribute('target', '_blank');
    expect(support).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: copy.footer.infoLinks.contacts })).toBeNull();
  });
});
