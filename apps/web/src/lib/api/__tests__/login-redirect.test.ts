import { describe, expect, it } from 'vitest';
import { loginRedirectTarget, safeNextPath } from '../login-redirect';

describe('loginRedirectTarget', () => {
  it('sends the default locale to /login with the current path as next', () => {
    expect(loginRedirectTarget('/store/orders', '?page=2')).toBe(
      '/login?next=%2Fstore%2Forders%3Fpage%3D2',
    );
  });

  it('keeps the Russian prefix', () => {
    expect(loginRedirectTarget('/ru/store', '')).toBe('/ru/login?next=%2Fru%2Fstore');
  });

  it('does not redirect from the login page itself', () => {
    expect(loginRedirectTarget('/login', '?next=%2Fstore')).toBeNull();
    expect(loginRedirectTarget('/ru/login', '')).toBeNull();
  });

  it('encodes a hostile next so it stays one query value', () => {
    const target = loginRedirectTarget('/store', '?a=b&next=//evil.example');
    expect(target).toBe('/login?next=%2Fstore%3Fa%3Db%26next%3D%2F%2Fevil.example');
  });
});

describe('safeNextPath', () => {
  const FALLBACK = '/store';

  it.each([
    ['//evil.com'],
    ['/\\evil.com'],
    ['\\\\evil.com'],
    ['/\\/evil.com'],
    ['/\t/evil.com'],
    ['/\n/evil.com'],
    ['/\r/evil.com'],
    ['https://evil.com'],
    ['javascript:alert(1)'],
    ['/%2F%2Fevil.com'],
    ['/%5Cevil.com'],
    ['/login?next=%2Fstore'],
    ['/ru/login'],
    ['/uz/login/'],
    ['evil.com'],
    // Dot segments that the URL parser resolves into a protocol-relative `//evil.com`.
    ['/.//evil.com'],
    ['/..//evil.com'],
    ['/a/..//evil.com'],
    ['/store/..//evil.com'],
    ['/%2e//evil.com'],
    ['/%2e%2e//evil.com'],
    ['/%2E%2E//evil.com'],
    ['/.%2e//evil.com'],
    ['/.//evil.com/x?y=1'],
    // Encoded dot segments and slashes that only become `//evil.com` after decoding and resolving.
    ['/%2e%2e%2f%2fevil.com'],
    ['/%2E%2E%2F%2Fevil.com'],
    ['/a%2f..%2f%2fevil.com'],
    ['/%2e%2f%2fevil.com'],
    // The login page spelled with percent-encoding, in every locale.
    ['/%6Cogin'],
    ['/ru/%6Cogin'],
    ['/uz/%6cogin/'],
    ['/LOGIN'],
    ['/%E0%A4%A'],
    [''],
    [null],
    [undefined],
  ])('falls back for %j', (next) => {
    expect(safeNextPath(next, FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    ['/store', '/store'],
    ['/ru/store/orders?page=2', '/ru/store/orders?page=2'],
    ['/search?q=100%25', '/search?q=100%25'],
    ['/store/product/a%20b', '/store/product/a%20b'],
    ['/store/product/telegram-stars?sku=sku_1', '/store/product/telegram-stars?sku=sku_1'],
  ])('keeps the same-origin path %s', (next, expected) => {
    expect(safeNextPath(next, FALLBACK)).toBe(expected);
  });

  it('drops a hash', () => {
    expect(safeNextPath('/store#t=secret', FALLBACK)).toBe('/store');
  });

  it('round-trips what loginRedirectTarget builds', () => {
    const target = loginRedirectTarget('/ru/store/orders', '?page=2');
    const next = new URL(target ?? '', 'https://site.test').searchParams.get('next');
    expect(safeNextPath(next, FALLBACK)).toBe('/ru/store/orders?page=2');
  });
});
