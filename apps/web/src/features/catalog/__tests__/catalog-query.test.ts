import type { CatalogCategory, CatalogProductListItem } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { groupByCategory, parseCategory, sanitizeSearch } from '../catalog-query';

describe('sanitizeSearch', () => {
  it('trims and keeps inner spaces', () => {
    expect(sanitizeSearch('  pubg mobile  ')).toBe('pubg mobile');
    expect(sanitizeSearch('   ')).toBe('');
    expect(sanitizeSearch('')).toBe('');
  });

  it('cuts at 64 characters, counting characters and not UTF-16 halves', () => {
    expect(sanitizeSearch('a'.repeat(100))).toHaveLength(64);
    const emoji = sanitizeSearch('🎮'.repeat(80));
    expect(Array.from(emoji)).toHaveLength(64);
    // No lone surrogate at the cut.
    expect(emoji.endsWith('🎮')).toBe(true);
  });

  it('removes control characters the API would refuse (a NUL byte is a 500 there)', () => {
    expect(sanitizeSearch('pu\u0000bg\u0007')).toBe('pubg');
    expect(sanitizeSearch('a\tb\nc')).toBe('abc');
    expect(sanitizeSearch('x\u0085y\u009fz')).toBe('xyz');
  });

  it('trims again after the cut, so the result never ends in a space', () => {
    expect(sanitizeSearch(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
  });

  it('keeps Cyrillic and Uzbek letters as they are', () => {
    expect(sanitizeSearch('  Игры  ')).toBe('Игры');
    expect(sanitizeSearch('o‘yin')).toBe('o‘yin');
  });
});

describe('parseCategory', () => {
  it('accepts a slug and nothing else', () => {
    expect(parseCategory('games')).toBe('games');
    expect(parseCategory('mobile-games-2')).toBe('mobile-games-2');
    for (const bad of [
      '',
      'Games',
      'a b',
      'a;b',
      '../x',
      '-a',
      'a-',
      'a--b',
      'x'.repeat(65),
      null,
      undefined,
    ]) {
      expect(parseCategory(bad)).toBeUndefined();
    }
  });
});

const category = (slug: string, count = 1): CatalogCategory => ({
  slug,
  name: slug.toUpperCase(),
  productCount: count,
});
const product = (slug: string, categorySlug: string): CatalogProductListItem => ({
  id: slug,
  slug,
  categorySlug,
  name: slug,
  imageUrl: `/assets/${slug}.svg`,
  regionBadge: null,
  deliveryType: 'GAME_ID',
  isAuto: true,
  isFeatured: false,
  inStock: true,
  fromPriceTiyin: '100',
});

describe('groupByCategory', () => {
  const categories = [category('telegram'), category('games'), category('platforms')];

  it('groups by category in the category order, not the product order', () => {
    const sections = groupByCategory(categories, [
      product('steam', 'platforms'),
      product('pubg', 'games'),
      product('stars', 'telegram'),
      product('mlbb', 'games'),
    ]);
    expect(sections.map((s) => s.category?.slug)).toEqual(['telegram', 'games', 'platforms']);
    expect(sections[1]?.items.map((p) => p.slug)).toEqual(['pubg', 'mlbb']);
  });

  it('leaves out a category with no product', () => {
    const sections = groupByCategory(categories, [product('pubg', 'games')]);
    expect(sections.map((s) => s.category?.slug)).toEqual(['games']);
  });

  it('keeps a product whose category is unknown in a trailing untitled section', () => {
    const sections = groupByCategory(categories, [product('pubg', 'games'), product('x', 'new')]);
    expect(sections.map((s) => s.category?.slug ?? null)).toEqual(['games', null]);
    expect(sections[1]?.items.map((p) => p.slug)).toEqual(['x']);
  });

  it('with no category list at all, still shows every product', () => {
    const sections = groupByCategory([], [product('pubg', 'games')]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.category).toBeNull();
  });

  it('is empty for no products', () => {
    expect(groupByCategory(categories, [])).toEqual([]);
  });
});
