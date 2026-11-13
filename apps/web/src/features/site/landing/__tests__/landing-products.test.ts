import type { CatalogProductListItem } from '@repo/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SitePage } from '../../seo/site-pages';
import { COMING_SOON } from '../coming-soon';
import { buildLandingProducts, landingPriceAmount, productPath } from '../landing-products';

const product = (
  slug: string,
  extra: Partial<CatalogProductListItem> = {},
): CatalogProductListItem => ({
  id: `id_${slug}`,
  slug,
  categorySlug: 'telegram',
  name: slug,
  imageUrl: `/assets/products/${slug}.svg`,
  regionBadge: null,
  deliveryType: 'TG_USERNAME',
  isAuto: true,
  isFeatured: false,
  inStock: true,
  fromPriceTiyin: '550000',
  ...extra,
});

const page = (path: SitePage['path']): SitePage => ({
  path,
  kind: 'product',
  indexable: true,
  lastModified: '2026-11-12',
  changeFrequency: 'monthly',
  priority: 0.8,
});

// formatMoney groups thousands with the narrow no-break space, so a price never breaks in two.
const NARROW_NBSP = String.fromCharCode(0x202f);

const soonSlugs = COMING_SOON.map((item) => item.slug);

describe('buildLandingProducts', () => {
  it('shows the API products live and the rest of the "soon" list after them', () => {
    const view = buildLandingProducts([
      product('telegram-stars'),
      product('telegram-premium', { fromPriceTiyin: '16500000' }),
    ]);
    expect(view.state).toBe('ok');
    expect(view.tiles.map((tile) => [tile.slug, tile.kind])).toEqual([
      ['telegram-stars', 'live'],
      ['telegram-premium', 'live'],
      ...soonSlugs.map((slug) => [slug, 'soon']),
    ]);
    const [stars] = view.tiles;
    expect(stars).toMatchObject({
      name: 'telegram-stars',
      fromPriceTiyin: '550000',
      delivery: 'auto',
      // The product's own page (phase 8 S3), as it is in the site registry.
      path: '/telegram-stars',
    });
  });

  it('keeps the price exactly as the server sent it, and drops it when there is none', () => {
    const view = buildLandingProducts([
      product('telegram-stars', { fromPriceTiyin: null }),
      product('telegram-premium', { fromPriceTiyin: '16500000' }),
    ]);
    expect(view.tiles.map((tile) => tile.fromPriceTiyin).slice(0, 2)).toEqual([null, '16500000']);
  });

  it('does not announce a game as "soon" once the API serves it', () => {
    const view = buildLandingProducts([product('telegram-stars'), product('pubg-mobile')]);
    const pubg = view.tiles.filter((tile) => tile.slug === 'pubg-mobile');
    expect(pubg).toHaveLength(1);
    expect(pubg[0]?.kind).toBe('live');
    expect(view.tiles.filter((tile) => tile.kind === 'soon').map((tile) => tile.slug)).toEqual(
      soonSlugs.filter((slug) => slug !== 'pubg-mobile'),
    );
  });

  it('draws "soon" tiles with no price and no link', () => {
    const soon = buildLandingProducts([product('telegram-stars')]).tiles.filter(
      (tile) => tile.kind === 'soon',
    );
    expect(soon).toHaveLength(COMING_SOON.length);
    for (const tile of soon) {
      expect(tile.path).toBeNull();
      expect(tile.fromPriceTiyin).toBeNull();
      expect(tile.name).toBeNull();
      expect(tile.nameKey).not.toBeNull();
    }
  });

  it('degrades to Stars and Premium without prices when the API cannot be used', () => {
    const view = buildLandingProducts(null);
    expect(view.state).toBe('unavailable');
    expect(view.tiles.map((tile) => [tile.slug, tile.kind])).toEqual([
      ['telegram-stars', 'live'],
      ['telegram-premium', 'live'],
      ...soonSlugs.map((slug) => [slug, 'soon']),
    ]);
    expect(view.tiles.every((tile) => tile.fromPriceTiyin === null)).toBe(true);
    expect(view.tiles[0]).toMatchObject({
      nameKey: 'stars',
      // The product's own page (phase 8 S3), as it is in the site registry.
      path: '/telegram-stars',
    });
  });

  it('shows only "soon" tiles for an empty catalog', () => {
    const view = buildLandingProducts([]);
    expect(view.state).toBe('empty');
    expect(view.tiles.map((tile) => tile.kind)).toEqual(soonSlugs.map(() => 'soon'));
  });

  it('marks a voucher as a code and a manual product as neither', () => {
    const [voucher, manual] = buildLandingProducts([
      product('roblox', { isAuto: false, deliveryType: 'VOUCHER' }),
      product('steam', { isAuto: false, deliveryType: 'STEAM_LOGIN' }),
    ]).tiles;
    expect(voucher?.delivery).toBe('code');
    expect(manual?.delivery).toBeNull();
  });
});

describe('productPath', () => {
  it('goes to the SEO page when the site has one, else to the product in the store', () => {
    const pages = [page('/'), page('/telegram-stars')];
    expect(productPath('telegram-stars', pages)).toBe('/telegram-stars');
    expect(productPath('telegram-premium', pages)).toBe('/store/products/telegram-premium');
  });

  it('builds the tile links with the same rule', () => {
    const view = buildLandingProducts([product('telegram-stars')], [page('/telegram-stars')]);
    expect(view.tiles[0]?.path).toBe('/telegram-stars');
  });
});

describe('landingPriceAmount', () => {
  it('lays a tiyin string out with the locale grouping', () => {
    expect(landingPriceAmount('1100000', 'uz')).toBe(`11${NARROW_NBSP}000`);
    expect(landingPriceAmount('16500000', 'ru')).toBe(`165${NARROW_NBSP}000`);
  });

  it('has no price for null, zero or anything that is not a tiyin string', () => {
    expect(landingPriceAmount(null, 'uz')).toBeNull();
    expect(landingPriceAmount('0', 'uz')).toBeNull();
    expect(landingPriceAmount('', 'uz')).toBeNull();
    expect(landingPriceAmount('12.5', 'uz')).toBeNull();
    expect(landingPriceAmount('abc', 'ru')).toBeNull();
  });
});

describe('money handling', () => {
  it('never converts a price through Number (money is a string or a BigInt)', () => {
    for (const file of ['landing-products.ts', 'ProductsGrid.tsx', 'SiteProductCard.tsx']) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(source, file).not.toMatch(/\bNumber\s*\(|parseFloat|parseInt|\bMath\./);
    }
  });
});
