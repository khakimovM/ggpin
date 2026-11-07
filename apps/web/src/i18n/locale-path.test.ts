import { describe, expect, it } from 'vitest';
import { stripLocale, switchLocalePath } from './locale-path';

describe('stripLocale', () => {
  it('removes the ru prefix, and leaves the default locale alone', () => {
    expect(stripLocale('/ru/store')).toBe('/store');
    expect(stripLocale('/ru')).toBe('/');
    expect(stripLocale('/store/profile')).toBe('/store/profile');
    expect(stripLocale('/')).toBe('/');
  });

  it('only a whole first segment is a locale', () => {
    expect(stripLocale('/rus/store')).toBe('/rus/store');
    expect(stripLocale('/store/ru')).toBe('/store/ru');
    expect(stripLocale('/uz/store')).toBe('/uz/store');
  });
});

describe('switchLocalePath', () => {
  it('moves the same page to the other language, keeping the query', () => {
    expect(switchLocalePath('/store', '?q=pubg', 'ru')).toBe('/ru/store?q=pubg');
    expect(switchLocalePath('/ru/store/profile', '', 'uz')).toBe('/store/profile');
    expect(switchLocalePath('/ru', '', 'uz')).toBe('/');
    expect(switchLocalePath('/', '', 'ru')).toBe('/ru');
  });
});
