import type { CatalogProductListItem } from '@repo/shared';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import type { SiteProductLookup } from '../../catalog-server';
import { settleServerTree } from '../../landing/__tests__/render-server';
import type { SiteLinks } from '../../shell/site-links';
import { ProductSeoPage } from '../ProductSeoPage';
import { seoProduct, type SeoProductSlug } from '../seo-products';
import { NOT_FOUND, ok, PREMIUM, STARS, UNAVAILABLE } from './product-kit';

vi.mock(
  'next-intl/server',
  async () => (await import('../../shell/__tests__/intl-server-mock')).intlServerMock,
);
vi.mock('../../../../csp/request-nonce', () => ({ requestNonce: () => Promise.resolve('n0nce') }));

const catalog = vi.hoisted(() => ({
  lookup: null as SiteProductLookup | null,
  list: null as CatalogProductListItem[] | null,
}));
vi.mock('../product-data', () => ({
  loadProduct: () => Promise.resolve(catalog.lookup),
}));
vi.mock('../../catalog-server', () => ({ getSiteProducts: () => Promise.resolve(catalog.list) }));

const links = vi.hoisted((): { value: SiteLinks } => ({
  value: { bot: 'https://t.me/test_bot', botHandle: '@test_bot', channel: null, support: null },
}));
vi.mock('../../shell/site-links', () => ({ siteLinks: () => links.value }));

const listItem = (slug: string, name: string, price: string | null): CatalogProductListItem => ({
  id: `id_${slug}`,
  slug,
  categorySlug: 'x',
  name,
  imageUrl: '/assets/products/x.svg',
  regionBadge: null,
  deliveryType: 'TG_USERNAME',
  isAuto: true,
  isFeatured: false,
  inStock: true,
  fromPriceTiyin: price,
});

beforeEach(() => {
  catalog.lookup = ok(STARS);
  catalog.list = [
    listItem('telegram-stars', 'Telegram Stars', '550000'),
    listItem('telegram-premium', 'Telegram Premium', '16500000'),
    listItem('pubg-mobile', 'PUBG Mobile', '1215000'),
  ];
  links.value = {
    bot: 'https://t.me/test_bot',
    botHandle: '@test_bot',
    channel: null,
    support: null,
  };
});

const draw = async (slug: SeoProductSlug, locale: 'uz' | 'ru') =>
  render(await settleServerTree(await ProductSeoPage({ locale, seo: seoProduct(slug) })));

const jsonLd = (container: HTMLElement) =>
  [...container.querySelectorAll('script[type="application/ld+json"]')].map(
    (script) => JSON.parse(script.textContent ?? 'null') as Record<string, unknown>,
  );

// A note with the API's minimum (50), spaced as Testing Library reads it: its normalizer makes the
// no-break spaces that bind "50 ⭐" in the catalog plain ones.
const minNote = (text: string) => text.replace('{min, number}', '50').replace(/\s+/g, ' ');

describe.each(['uz', 'ru'] as const)('the Stars page (%s)', (locale) => {
  const copy = MESSAGES[locale].site;
  const stars = copy.product.stars;
  const common = copy.product.common;
  const store = locale === 'uz' ? '/store' : '/ru/store';

  it('filled: the title, the lead, the packages with the server prices and the buy button', async () => {
    await draw('telegram-stars', locale);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Telegram Stars');
    expect(screen.getByText(stars.lead)).toBeInTheDocument();

    const group = screen.getByRole('radiogroup', { name: stars.packages.label });
    const rows = within(group).getAllByRole('radio');
    expect(rows.map((row) => row.textContent?.replace(/\s/g, ' '))).toEqual([
      expect.stringMatching(/^50 ⭐\s*11 000 (so‘m|сум)$/),
      expect.stringMatching(/^500 ⭐\s*110 000 (so‘m|сум)$/),
      expect.stringMatching(/^1000 ⭐\s*220 000 (so‘m|сум)$/),
    ]);
    // The buy button names the first package's price and leads into the store, not to a package.
    const buy = screen.getByRole('link', { name: /11\s000/ });
    expect(buy).toHaveAttribute('href', `${store}/products/telegram-stars`);
    expect(buy).toHaveTextContent(new RegExp(`^${common.buy.label} · 11\\s000`));
    // The notes under the list: the custom amount (from the API's minimum) and the estimate.
    expect(screen.getByText(minNote(stars.packages.customQty))).toBeInTheDocument();
    expect(screen.getByText(common.packages.approxNote)).toBeInTheDocument();
    const bot = screen.getByRole('link', { name: common.telegram });
    expect(bot).toHaveAttribute('href', 'https://t.me/test_bot');
    expect(bot).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('the cards under the picture: the price per star, the minimum and the delivery', async () => {
    const { container } = await draw('telegram-stars', locale);
    const cards = [...container.querySelectorAll('dl > div')].map((card) => ({
      label: card.querySelector('dt')?.textContent,
      value: card.querySelector('dd')?.textContent?.replace(/\s/g, ' '),
    }));
    expect(cards.map((card) => card.label)).toEqual([
      common.facts.unitPrice.label,
      common.facts.min.label,
      common.facts.delivery.label,
    ]);
    expect(cards[0]?.value).toMatch(/^1 ⭐ = 220 (so‘m|сум)$/);
    expect(cards.slice(1).map((card) => card.value)).toEqual([
      '50 ⭐',
      common.facts.delivery.value,
    ]);
  });

  it('the badges: automatic delivery from the API, and the region only when there is one', async () => {
    catalog.lookup = ok({ ...STARS, regionBadge: 'GLOBAL' });
    await draw('telegram-stars', locale);
    const hero = screen.getByRole('heading', { level: 1 }).closest('section');
    if (hero === null) throw new Error('no hero');
    expect(within(hero).getByText(MESSAGES[locale].store.catalog.badge.auto)).toBeInTheDocument();
    // Both chips share one row, right above the title.
    const row = within(hero).getByText('GLOBAL').closest('div');
    expect(row?.nextElementSibling).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('the sections in order, with the right heading levels', async () => {
    await draw('telegram-stars', locale);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      stars.how.title,
      stars.faq.title,
      common.related.title,
    ]);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      stars.how.s1.title,
      stars.how.s2.title,
      stars.how.s3.title,
      ...[stars.faq.items.q1, stars.faq.items.q2, stars.faq.items.q3, stars.faq.items.q4],
      // The tiles of the other products are cards, not headings.
    ]);
  });

  it('the breadcrumb: home, products, and the page itself as the current one', async () => {
    await draw('telegram-stars', locale);
    const nav = screen.getByRole('navigation', { name: common.breadcrumb.label });
    const home = locale === 'uz' ? '/' : '/ru';
    expect(within(nav).getByRole('link', { name: common.breadcrumb.home })).toHaveAttribute(
      'href',
      home,
    );
    expect(within(nav).getByRole('link', { name: common.breadcrumb.products })).toHaveAttribute(
      'href',
      `${home}#products`,
    );
    expect(within(nav).getByText('Telegram Stars')).toHaveAttribute('aria-current', 'page');
  });

  it('structured data: the trail and the questions, with the nonce, and no Product', async () => {
    const { container } = await draw('telegram-stars', locale);
    const blocks = jsonLd(container);
    expect(blocks.map((block) => block['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
    const trail = blocks[0]?.itemListElement as { position: number; name: string; item: string }[];
    // Home and the product: the visible "Mahsulotlar" step is a `/#products` fragment, which is not
    // a page of its own for a search engine.
    expect(trail.map((entry) => entry.position)).toEqual([1, 2]);
    expect(trail[1]?.name).toBe('Telegram Stars');
    expect(trail[1]?.item).toMatch(locale === 'uz' ? /\/telegram-stars$/ : /\/ru\/telegram-stars$/);
    expect(trail.some((entry) => entry.item.includes('#'))).toBe(false);
    const questions = blocks[1]?.mainEntity as { name: string }[];
    expect(questions.map((question) => question.name)).toEqual([
      stars.faq.items.q1,
      stars.faq.items.q2,
      stars.faq.items.q3,
      stars.faq.items.q4,
    ]);
    for (const script of container.querySelectorAll('script[type="application/ld+json"]')) {
      expect((script as HTMLScriptElement).nonce).toBe('n0nce');
    }
    expect(container.innerHTML).not.toMatch(/"Product"|"Offer"/);
  });

  it('the other products: the landing tiles without this product, with their own prices', async () => {
    await draw('telegram-stars', locale);
    const related = screen
      .getByRole('heading', { level: 2, name: common.related.title })
      .closest('section');
    if (related === null) throw new Error('no related section');
    const hrefs = within(related)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    // Premium is a page of its own now; PUBG still leads into the store.
    expect(hrefs).toEqual([
      locale === 'uz' ? '/telegram-premium' : '/ru/telegram-premium',
      `${store}/products/pubg-mobile`,
    ]);
    expect(within(related).queryByRole('link', { name: /Telegram Stars/ })).toBeNull();
  });

  it('catalog unavailable: no price anywhere, no package list, and the buy button stays', async () => {
    catalog.lookup = UNAVAILABLE;
    catalog.list = null;
    const { container } = await draw('telegram-stars', locale);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Telegram Stars');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByText(common.packages.noPrices)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: common.buy.label })).toHaveAttribute(
      'href',
      `${store}/products/telegram-stars`,
    );
    expect(container.textContent).not.toMatch(/\d\s(so‘m|сум)/);
    // Only the delivery card is known without the catalog; the page is a whole document still.
    expect([...container.querySelectorAll('dl dt')].map((dt) => dt.textContent)).toEqual([
      common.facts.delivery.label,
    ]);
    expect(jsonLd(container).map((block) => block['@type'])).toEqual(['BreadcrumbList', 'FAQPage']);
  });

  it('the product does not exist: it says so, the buy button is disabled, the page still renders', async () => {
    catalog.lookup = NOT_FOUND;
    await draw('telegram-stars', locale);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('Telegram Stars');
    // No empty chip row is left above the title (code review S3 #1): the column starts with it.
    expect(title.parentElement?.firstElementChild).toBe(title);
    expect(screen.getByText(common.unavailable.title)).toBeInTheDocument();
    expect(screen.getByText(common.unavailable.body)).toBeInTheDocument();
    const buy = screen.getByRole('button', { name: common.buy.label });
    expect(buy).toBeDisabled();
    expect(screen.queryByRole('link', { name: common.buy.label })).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(document.querySelector('dl')).toBeNull();
  });

  it('no packages: the minimum from the API and a note, the buy button leads into the store', async () => {
    catalog.lookup = ok({ ...STARS, skus: [] });
    const { container } = await draw('telegram-stars', locale);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByText(minNote(stars.packages.noPackagesMin))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: common.buy.label })).toHaveAttribute(
      'href',
      `${store}/products/telegram-stars`,
    );
    expect(container.textContent).toMatch(/50\s⭐/);
  });

  it('without a bot configured the Telegram button is left out', async () => {
    links.value = { ...links.value, bot: null, botHandle: null };
    await draw('telegram-stars', locale);
    expect(screen.queryByRole('link', { name: common.telegram })).toBeNull();
  });
});

describe.each(['uz', 'ru'] as const)('the Premium page (%s)', (locale) => {
  const premium = MESSAGES[locale].site.product.premium;
  const common = MESSAGES[locale].site.product.common;

  it("plans from the API labels, one with no price; the facts are Premium's own", async () => {
    catalog.lookup = ok(PREMIUM);
    const { container } = await draw('telegram-premium', locale);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Telegram Premium');
    expect(screen.getByText(premium.lead)).toBeInTheDocument();
    const rows = within(
      screen.getByRole('radiogroup', { name: premium.packages.label }),
    ).getAllByRole('radio');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('3 oylik');
    expect(rows[0]).toHaveTextContent(/165\s000/);
    // No fresh price for the second one: nothing is invented.
    expect(rows[1]).toHaveTextContent('12 oylik');
    expect(rows[1]?.textContent).not.toMatch(/\d\s(so‘m|сум)/);
    // No "per month" or "best value" claim: the browser works nothing out.
    expect(container.textContent).not.toMatch(/oyiga|в месяц|Eng foydali|Выгодно/);
    expect([...container.querySelectorAll('dl dt')].map((dt) => dt.textContent)).toEqual([
      common.facts.plans.label,
      common.facts.delivery.label,
      common.facts.recipient.label,
    ]);
    // No custom amount: only the estimate note.
    expect(screen.getByText(common.packages.approxNote)).toBeInTheDocument();
    expect(screen.queryByText(/⭐/, { selector: 'p' })).toBeNull();
  });

  it('its own title, questions and structured data', async () => {
    catalog.lookup = ok(PREMIUM);
    const { container } = await draw('telegram-premium', locale);
    expect(screen.getByRole('heading', { level: 2, name: premium.how.title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: premium.faq.title })).toBeInTheDocument();
    const faq = jsonLd(container)[1];
    expect((faq?.mainEntity as unknown[]).length).toBe(4);
  });
});
