import { describe, expect, it } from 'vitest';
import { helpSteps } from '../HowToFindSheet';
import { formatClock } from '../OrderSummary';
import { tabsOf } from '../PackageSection';
import { telegramPhotoSrc } from '../photo-src';

describe('formatClock', () => {
  it('shows minutes and seconds, rounding a started second up', () => {
    expect(formatClock(600_000)).toBe('10:00');
    expect(formatClock(125_000)).toBe('02:05');
    expect(formatClock(59_001)).toBe('01:00');
    expect(formatClock(1)).toBe('00:01');
  });

  it('never goes below zero', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(-5000)).toBe('00:00');
  });
});

describe('helpSteps', () => {
  it('one step per non-empty line, markup untouched', () => {
    expect(helpSteps('a\r\n\n  <b>b</b>  \n')).toEqual(['a', '<b>b</b>']);
    expect(helpSteps('   ')).toEqual([]);
  });
});

describe('tabsOf', () => {
  const sku = (id: string, tab: string | null) => ({
    id,
    label: id,
    quantity: 1,
    tab,
    fromPriceTiyin: null,
  });
  it('lists each group once, in catalog order, and ignores packages without one', () => {
    const product = { skus: [sku('a', 'X'), sku('b', null), sku('c', 'Y'), sku('d', 'X')] };
    expect(tabsOf(product as never)).toEqual(['X', 'Y']);
  });
});

describe('telegramPhotoSrc', () => {
  it('lets only Telegram hosts over https through (the CSP would block the rest)', () => {
    expect(telegramPhotoSrc('https://t.me/i/userpic/320/a.jpg')).toBe(
      'https://t.me/i/userpic/320/a.jpg',
    );
    expect(telegramPhotoSrc('https://cdn5.telegram.org/x.jpg')).toBeDefined();
    expect(telegramPhotoSrc('https://cdn.example/a.jpg')).toBeUndefined();
    expect(telegramPhotoSrc('http://t.me/a.jpg')).toBeUndefined();
    expect(telegramPhotoSrc('https://evil-telegram.org/a.jpg')).toBeUndefined();
    expect(telegramPhotoSrc('not a url')).toBeUndefined();
    expect(telegramPhotoSrc(undefined)).toBeUndefined();
  });
});
