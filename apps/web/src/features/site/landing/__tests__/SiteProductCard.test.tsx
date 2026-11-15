import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LandingTile } from '../landing-products';
import { SiteProductCard, type SiteProductCardLabels } from '../SiteProductCard';

const LABELS: SiteProductCardLabels = {
  popular: 'Popular',
  auto: 'Auto',
  code: 'Code',
  soldOut: 'Sold out',
  soon: 'Soon',
  soonNote: 'We will tell you',
};

const live = (extra: Partial<LandingTile> = {}): LandingTile => ({
  kind: 'live',
  slug: 'telegram-stars',
  name: 'Telegram Stars',
  nameKey: null,
  path: '/store/products/telegram-stars',
  fromPriceTiyin: '550000',
  regionBadge: null,
  featured: false,
  delivery: 'auto',
  inStock: true,
  imageUrl: null,
  ...extra,
});

const soon: LandingTile = {
  ...live(),
  kind: 'soon',
  slug: 'pubg-mobile',
  name: null,
  nameKey: 'pubg',
  path: null,
  fromPriceTiyin: null,
  delivery: null,
};

function draw(tile: LandingTile, extra: { price?: string | null; href?: string | null } = {}) {
  const { price = '5 500 so‘m', href = '/store/products/telegram-stars' } = extra;
  return render(
    <ul>
      <SiteProductCard
        tile={tile}
        name={tile.name ?? 'PUBG Mobile'}
        href={href}
        price={price}
        labels={LABELS}
      />
    </ul>,
  );
}

describe('SiteProductCard', () => {
  it('is a link with the product name, the delivery badge and the price', () => {
    draw(live());
    const link = screen.getByRole('link', { name: /Telegram Stars/ });
    expect(link).toHaveAttribute('href', '/store/products/telegram-stars');
    expect(within(link).getByText('Auto')).toBeInTheDocument();
    expect(within(link).getByText('5 500 so‘m')).toBeInTheDocument();
  });

  it('draws no price line when the caller has no price (an API without a fresh price)', () => {
    draw(live({ fromPriceTiyin: null }), { price: null });
    expect(screen.queryByText(/so‘m/)).toBeNull();
  });

  it('shows the popular and region badges and the sold-out chip when they apply', () => {
    draw(live({ featured: true, regionBadge: 'GLOBAL', inStock: false }));
    expect(screen.getByText('Popular')).toBeInTheDocument();
    expect(screen.getByText('GLOBAL')).toBeInTheDocument();
    expect(screen.getByText('Sold out')).toBeInTheDocument();
  });

  // Site.dc.html: the "Mashhur" badge carries a flame, and the delivery chip is plain text.
  it('draws the popular badge with a flame and the delivery chip without an icon', () => {
    draw(live({ featured: true }));
    expect(screen.getByText('Popular').querySelector('svg.lucide-flame')).not.toBeNull();
    expect(screen.getByText('Auto').querySelector('svg')).toBeNull();
  });

  it('marks a voucher as a code', () => {
    draw(live({ delivery: 'code' }));
    expect(screen.getByText('Code')).toBeInTheDocument();
    expect(screen.queryByText('Auto')).toBeNull();
  });

  it('draws a "soon" tile that is not a link, with no price and no delivery badge', () => {
    draw(soon, { href: null, price: null });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Soon')).toBeInTheDocument();
    expect(screen.getByText('We will tell you')).toBeInTheDocument();
    expect(screen.queryByText('Auto')).toBeNull();
    expect(screen.queryByText(/so‘m/)).toBeNull();
  });

  it('gives Stars and Premium a glyph, not a broken picture slot', () => {
    const { container } = draw(live());
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
