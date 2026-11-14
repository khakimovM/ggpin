import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import type { SiteLinks } from '../../shell/site-links';
import { placeholderTexts, type PlaceholderTexts } from '../product-placeholder';
import { BuyPanelSkeleton, FactsSkeleton } from '../product-skeletons';
import { seoProduct } from '../seo-products';

// The placeholders of a product page (drawn here directly: the page tests settle every <Suspense>
// and never draw one). They take the room of the catalog's answer by holding its texts, around
// stand-in numbers; those texts must never be the page's text, shown or read out.

vi.mock(
  'next-intl/server',
  async () => (await import('../../shell/__tests__/intl-server-mock')).intlServerMock,
);

const links = vi.hoisted((): { bot: string | null } => ({ bot: 'https://t.me/test_bot' }));
vi.mock('../../shell/site-links', () => ({
  siteLinks: (): SiteLinks => ({ bot: links.bot, botHandle: null, channel: null, support: null }),
}));

beforeEach(() => {
  links.bot = 'https://t.me/test_bot';
});

// The stand-ins of product-placeholder.ts: a three-digit price and the usual minimum.
const PRICE = '000';
const MIN = '50';

const draw = (texts: PlaceholderTexts) =>
  render(
    <>
      <FactsSkeleton cards={texts.facts} />
      <BuyPanelSkeleton texts={texts} />
    </>,
  );

/** The list's card and the buttons' row: the two parts of the panel, both hidden from readers. */
const panelParts = () =>
  screen.getByRole('status').querySelectorAll(':scope > [aria-hidden="true"]');

describe.each(['uz', 'ru'] as const)('the placeholders of a product page (%s)', (locale) => {
  const { site, common: shared } = MESSAGES[locale];
  const { common, stars } = site.product;

  it('Stars: the cards and the small print of a filled page, around stand-in numbers', async () => {
    const seo = seoProduct('telegram-stars');
    const texts = await placeholderTexts(locale, seo);
    expect(texts.facts).toEqual([
      {
        kind: 'unitPrice',
        label: common.facts.unitPrice.label,
        value: stars.facts.unitPrice.value.replace(
          '{price}',
          shared.money.uzs.replace('{amount}', PRICE),
        ),
      },
      {
        kind: 'min',
        label: common.facts.min.label,
        value: stars.facts.min.value.replace('{min, number}', MIN),
      },
      { kind: 'delivery', label: common.facts.delivery.label, value: common.facts.delivery.value },
    ]);
    expect(texts.rows).toBe(seo.packages);
    expect(texts.notes).toEqual([
      stars.packages.customQty.replace('{min, number}', MIN),
      common.packages.approxNote,
    ]);
    expect(texts.telegram).toBe(common.telegram);
    expect(texts.loading).toBe(common.loading);
  });

  it('Premium: its plans counted from the registry, no minimum to type', async () => {
    const seo = seoProduct('telegram-premium');
    const texts = await placeholderTexts(locale, seo);
    const [plans, ...rest] = texts.facts;
    expect(plans?.label).toBe(common.facts.plans.label);
    expect(plans?.value).toMatch(new RegExp(`^${String(seo.packages)}\\D`));
    expect(rest).toEqual([
      { kind: 'delivery', label: common.facts.delivery.label, value: common.facts.delivery.value },
      {
        kind: 'recipient',
        label: common.facts.recipient.label,
        value: common.facts.recipient.value,
      },
    ]);
    expect(texts.rows).toBe(seo.packages);
    expect(texts.notes).toEqual([common.packages.approxNote]);
  });

  describe.each(['telegram-stars', 'telegram-premium'] as const)('%s, drawn', (slug) => {
    it('hold their texts as attributes only: the page text is the status, nothing else', async () => {
      const texts = await placeholderTexts(locale, seoProduct(slug));
      const { container } = draw(texts);
      // A stand-in number above all must never be read as a price.
      expect(container.textContent).toBe(texts.loading);
      expect(container.textContent).not.toContain(PRICE);
      const ghosts = [...container.querySelectorAll('[data-ghost]')];
      expect(ghosts.map((ghost) => ghost.getAttribute('data-ghost'))).toEqual([
        ...texts.facts.flatMap(({ label, value }) => [label, value]),
        ...texts.notes,
        texts.telegram,
      ]);
      for (const ghost of ghosts) {
        expect(ghost).toBeEmptyDOMElement();
        expect(ghost).toHaveClass('invisible');
      }
    });

    it('hide their shapes from readers, with one busy status that says what is loading', async () => {
      const seo = seoProduct(slug);
      const { container } = draw(await placeholderTexts(locale, seo));
      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-busy', 'true');
      expect(status).toHaveTextContent(common.loading);
      const [list, buttons] = panelParts();
      // The card holds its head, then the rows, then the small print (as PackagePicker does).
      expect(list?.children[1]?.children).toHaveLength(seo.packages);
      // The buy button's room and the Telegram button's.
      expect(buttons?.children).toHaveLength(2);
    });

    it('with no bot configured, keep no room for the Telegram button the page will not draw', async () => {
      links.bot = null;
      const texts = await placeholderTexts(locale, seoProduct(slug));
      expect(texts.telegram).toBeNull();
      const { container } = draw(texts);
      const ghosts = [...container.querySelectorAll('[data-ghost]')];
      expect(ghosts.map((ghost) => ghost.getAttribute('data-ghost'))).not.toContain(
        common.telegram,
      );
      const [, buttons] = panelParts();
      expect(buttons?.children).toHaveLength(1);
    });
  });
});
