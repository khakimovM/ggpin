import type { CatalogProductListItem } from '@repo/shared';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { ProductCard } from '../ProductCard';

const BASE: CatalogProductListItem = {
  id: 'p1',
  slug: 'pubg-mobile',
  categorySlug: 'games',
  name: 'PUBG Mobile',
  imageUrl: '/assets/products/pubg-mobile.svg',
  regionBadge: 'GLOBAL',
  deliveryType: 'GAME_ID',
  isAuto: true,
  isFeatured: true,
  inStock: true,
  fromPriceTiyin: '1215000',
};

const render = (product: Partial<CatalogProductListItem>, locale: 'uz' | 'ru' = 'uz') =>
  renderApp(<ProductCard product={{ ...BASE, ...product }} href="/tg/products/pubg-mobile" />, {
    locale,
  });

describe('ProductCard', () => {
  it('links to the product and shows the server price with "dan" after it', () => {
    render({});
    const link = screen.getByRole('link', { name: /PUBG Mobile/ });
    expect(link).toHaveAttribute('href', '/tg/products/pubg-mobile');
    expect(link).toHaveTextContent(/12.150 so‘m\s*dan/);
  });

  it('puts "от" before the price in Russian', () => {
    render({}, 'ru');
    expect(screen.getByRole('link')).toHaveTextContent(/от\s*12.150 сум/);
  });

  it('shows no price line at all when the server has no fresh price', () => {
    render({ fromPriceTiyin: null });
    const link = screen.getByRole('link');
    expect(link).not.toHaveTextContent(/so‘m|dan|\d{3}/);
    // The rest of the card is still there.
    expect(link).toHaveTextContent('PUBG Mobile');
  });

  it('shows no price for a value that is not a tiyin string (never a made-up number)', () => {
    render({ fromPriceTiyin: '12.5' });
    expect(screen.getByRole('link')).not.toHaveTextContent(/so‘m|dan|—/);
  });

  it('shows a sold-out chip when the product is out of stock, and stays a link', () => {
    render({ inStock: false });
    expect(screen.getByRole('link')).toHaveTextContent('Tugagan');
    expect(screen.getByRole('link')).toHaveAttribute('href', '/tg/products/pubg-mobile');
  });

  it('no sold-out chip for a product in stock', () => {
    render({ inStock: true });
    expect(screen.queryByText('Tugagan')).not.toBeInTheDocument();
  });

  it('a sold-out product without a price shows the chip and no price', () => {
    render({ inStock: false, fromPriceTiyin: null });
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('Tugagan');
    expect(link).not.toHaveTextContent(/so‘m|dan/);
  });

  it('badges: popular, region, and the delivery kind', () => {
    render({});
    expect(screen.getByRole('link')).toHaveTextContent('Mashhur');
    expect(screen.getByRole('link')).toHaveTextContent('GLOBAL');
    expect(screen.getByRole('link')).toHaveTextContent('Avto');
  });

  it('a voucher that is not automatic is a "Promokod"; no region means no region badge', () => {
    render({ isAuto: false, deliveryType: 'VOUCHER', regionBadge: null, isFeatured: false });
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('Promokod');
    expect(link).not.toHaveTextContent(/GLOBAL|Mashhur|Avto/);
  });

  it('puts the name in the picture alternative text, and a foreign picture URL is not loaded', () => {
    render({ imageUrl: 'https://evil.example/x.png' });
    // No <img>: the empty slot is drawn, named after the product.
    expect(screen.queryByRole('img', { name: 'PUBG Mobile' })?.tagName).not.toBe('IMG');
    expect(document.querySelector('img')).toBeNull();
  });

  it('loads a path of the site', () => {
    render({});
    const image = document.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('alt')).toBe('PUBG Mobile');
  });
});
