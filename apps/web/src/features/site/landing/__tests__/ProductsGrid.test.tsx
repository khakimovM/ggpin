import type { CatalogProductListItem } from '@repo/shared';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { ProductsGrid } from '../ProductsGrid';
import { ProductsSkeleton } from '../ProductsSkeleton';

vi.mock(
  'next-intl/server',
  async () => (await import('../../shell/__tests__/intl-server-mock')).intlServerMock,
);

const catalog = vi.hoisted(() => ({ answer: null as CatalogProductListItem[] | null }));
vi.mock('../../catalog-server', () => ({
  getSiteProducts: () => Promise.resolve(catalog.answer),
}));

const item = (
  slug: string,
  name: string,
  fromPriceTiyin: string | null,
): CatalogProductListItem => ({
  id: `id_${slug}`,
  slug,
  categorySlug: 'telegram',
  name,
  imageUrl: `/assets/products/${slug}.svg`,
  regionBadge: null,
  deliveryType: 'TG_USERNAME',
  isAuto: true,
  isFeatured: false,
  inStock: true,
  fromPriceTiyin,
});

const FULL = [
  item('telegram-stars', 'Telegram Stars', '550000'),
  item('telegram-premium', 'Telegram Premium', '16500000'),
];

async function draw(locale: 'uz' | 'ru') {
  return render(await ProductsGrid({ locale }));
}

beforeEach(() => {
  catalog.answer = FULL;
});

describe('ProductsGrid (the four states of the products block)', () => {
  it('filled: live tiles with the server prices, then the "soon" tiles', async () => {
    await draw('uz');
    const stars = screen.getByRole('link', { name: /Telegram Stars/ });
    expect(within(stars).getByText('5 500 so‘m')).toBeInTheDocument();
    expect(within(stars).getByText('dan boshlab')).toBeInTheDocument();
    const premium = screen.getByRole('link', { name: /Telegram Premium/ });
    expect(within(premium).getByText('165 000 so‘m')).toBeInTheDocument();
    // The four announced games are there, with no link and no price.
    expect(screen.getAllByText('Tez orada')).toHaveLength(4);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('puts the Russian prefix before the price and the Russian unit after it', async () => {
    await draw('ru');
    const stars = screen.getByRole('link', { name: /Telegram Stars/ });
    expect(stars).toHaveTextContent(/от\s*5\s500\sсум/);
    expect(screen.getAllByText('Скоро')).toHaveLength(4);
  });

  it('error: no price anywhere, no banner, Stars and Premium still lead to the store', async () => {
    catalog.answer = null;
    const { container } = await draw('uz');
    expect(screen.getByRole('link', { name: /Telegram Stars/ })).toHaveAttribute(
      'href',
      '/store/products/telegram-stars',
    );
    expect(screen.getByRole('link', { name: /Telegram Premium/ })).toBeInTheDocument();
    expect(screen.getAllByText('Tez orada')).toHaveLength(4);
    expect(container.textContent).not.toMatch(/so‘m|dan boshlab/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a product without a fresh price is shown without one, never with a stale or zero price', async () => {
    catalog.answer = [item('telegram-stars', 'Telegram Stars', null), item('x', 'Zero', '0')];
    await draw('uz');
    expect(screen.getByRole('link', { name: /Telegram Stars/ })).not.toHaveTextContent('so‘m');
    expect(screen.getByRole('link', { name: /Zero/ })).not.toHaveTextContent('so‘m');
  });

  it('empty: only the "soon" tiles and a way into the bot', async () => {
    catalog.answer = [];
    await draw('uz');
    expect(screen.getAllByText('Tez orada')).toHaveLength(4);
    expect(screen.getByText(MESSAGES.uz.site.products.empty)).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: MESSAGES.uz.site.cta.telegram });
    expect(cta).toHaveAttribute('href', 'https://t.me/ggpin_bot');
    expect(cta).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('ProductsSkeleton (the loading state)', () => {
  it('announces loading once and hides the placeholder blocks', () => {
    render(<ProductsSkeleton label="Loading products" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('Loading products');
    expect(region.querySelector('ul')).toHaveAttribute('aria-hidden', 'true');
  });
});
