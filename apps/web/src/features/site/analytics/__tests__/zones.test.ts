import { describe, expect, it } from 'vitest';
import { zoneOf } from '../zones';

describe('zoneOf', () => {
  it.each([
    '/',
    '/ru',
    '/faq',
    '/ru/faq',
    '/terms',
    '/ru/privacy',
    '/contacts',
    '/telegram-stars',
    '/ru/telegram-premium',
    '/#products',
    '/terms?x=1',
  ])('a marketing page: %j', (href) => {
    expect(zoneOf(href)).toBe('marketing');
  });

  it.each([
    '/store',
    '/ru/store',
    '/store/orders',
    '/store/orders/cm3order',
    '/ru/store/profile',
    '/store/products/telegram-stars',
    '/store?q=uc',
    '/login',
    '/ru/login',
    '/login?next=%2Fstore',
    '/tg',
    '/tg/profile',
    '/pay/cm3intent',
  ])('a private page: %j', (href) => {
    expect(zoneOf(href)).toBe('private');
  });

  it.each([
    // Paths of ours in neither zone.
    '/unknown',
    '/faq/',
    '/storefront',
    '/login/extra',
    '/ru/tg',
    '/pay',
    '/tgx',
    // Not a plain path of our own site.
    'https://t.me/ggpin_bot',
    '//evil.example/store',
    '/\\evil.example/store',
    '/\\/evil.example/faq',
    '\\evil',
    '\\\\evil',
    'store',
    '',
  ])('unknown, which every caller treats as a zone change: %j', (href) => {
    expect(zoneOf(href)).toBe('unknown');
  });
});
