import type { CatalogProductListItem } from '@repo/shared';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { TelegramProductTile } from '../TelegramProductTile';

const STARS: CatalogProductListItem = {
  id: 'p1',
  slug: 'telegram-stars',
  categorySlug: 'telegram',
  name: 'Telegram Stars',
  imageUrl: '/assets/products/telegram-stars.svg',
  regionBadge: null,
  deliveryType: 'TG_USERNAME',
  isAuto: true,
  isFeatured: false,
  inStock: true,
  fromPriceTiyin: '550000',
};

const render = (product: Partial<CatalogProductListItem>) =>
  renderApp(
    <TelegramProductTile product={{ ...STARS, ...product }} href="/tg/products/telegram-stars" />,
  );

describe('TelegramProductTile', () => {
  it('shows the name, the server price and links to the product', () => {
    render({});
    const link = screen.getByRole('link', { name: /Telegram Stars/ });
    expect(link).toHaveAttribute('href', '/tg/products/telegram-stars');
    expect(link).toHaveTextContent(/5.500 so‘m\s*dan/);
  });

  it('a sold-out product shows the chip and stays a link', () => {
    render({ inStock: false });
    expect(screen.getByRole('link')).toHaveTextContent('Tugagan');
  });

  it('no sold-out chip for a product in stock', () => {
    render({});
    expect(screen.queryByText('Tugagan')).not.toBeInTheDocument();
  });

  it('no price line when there is no fresh price', () => {
    render({ fromPriceTiyin: null });
    expect(screen.getByRole('link')).not.toHaveTextContent(/so‘m|dan|\d{3}/);
  });

  it('with a picture: an empty alt (the name is printed next to it)', () => {
    render({});
    const image = document.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('alt')).toBe('');
    // The name is read once, from the text.
    expect(screen.getAllByText('Telegram Stars')).toHaveLength(1);
  });

  it('without a usable picture nothing covers the star: no image, no empty-slot box', () => {
    const { container } = render({ imageUrl: 'https://evil.example/x.png' });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The glyph (lucide svg) is still there.
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  it('Stars and Premium have their own look; another product gets the neutral tile', () => {
    const a = render({}).container.querySelector('a')?.className ?? '';
    const b = render({ slug: 'telegram-premium' }).container.querySelector('a')?.className ?? '';
    const c = render({ slug: 'something-else' }).container.querySelector('a')?.className ?? '';
    expect(a).toContain('--star-soft');
    expect(b).toContain('--premium-soft');
    expect(c).not.toMatch(/--star-soft|--premium-soft/);
  });
});
