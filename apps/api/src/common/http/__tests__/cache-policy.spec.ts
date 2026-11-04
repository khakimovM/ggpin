import { cacheControlFor, type CachePolicyInput } from '../cache-policy';
import { PublicCache } from '../public-cache.decorator';

const cacheable: CachePolicyInput = {
  routeMatched: true,
  method: 'GET',
  statusCode: 200,
  routeConfig: { ggpinPublicCache: { maxAgeSec: 60 } },
  hasSetCookie: false,
};

describe('cacheControlFor (default-deny cache policy)', () => {
  it('opted-in GET 200 without a cookie -> public, max-age=N', () => {
    expect(cacheControlFor(cacheable)).toBe('public, max-age=60');
  });

  it('HEAD is cacheable like GET', () => {
    expect(cacheControlFor({ ...cacheable, method: 'HEAD' })).toBe('public, max-age=60');
  });

  it('uses the max-age of the route', () => {
    const routeConfig = { ggpinPublicCache: { maxAgeSec: 3600 } };
    expect(cacheControlFor({ ...cacheable, routeConfig })).toBe('public, max-age=3600');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s -> no-store', (method) => {
    expect(cacheControlFor({ ...cacheable, method })).toBe('no-store');
  });

  it.each([201, 204, 304, 400, 401, 404, 422, 429, 500, 503])('status %i -> no-store', (code) => {
    expect(cacheControlFor({ ...cacheable, statusCode: code })).toBe('no-store');
  });

  it('a reply that sets a cookie -> no-store', () => {
    expect(cacheControlFor({ ...cacheable, hasSetCookie: true })).toBe('no-store');
  });

  it('no route matched (a 404) -> no-store, even if a config object is present', () => {
    expect(cacheControlFor({ ...cacheable, routeMatched: false })).toBe('no-store');
  });

  it.each([
    ['undefined config', undefined],
    ['null config', null],
    ['empty config', {}],
    ['marker is not an object', { ggpinPublicCache: true }],
    ['marker without maxAgeSec', { ggpinPublicCache: {} }],
    ['maxAgeSec as a string', { ggpinPublicCache: { maxAgeSec: '60' } }],
    ['maxAgeSec zero', { ggpinPublicCache: { maxAgeSec: 0 } }],
    ['maxAgeSec fractional', { ggpinPublicCache: { maxAgeSec: 1.5 } }],
    ['maxAgeSec NaN', { ggpinPublicCache: { maxAgeSec: Number.NaN } }],
  ])('route not (validly) opted in (%s) -> no-store', (_name, routeConfig) => {
    expect(cacheControlFor({ ...cacheable, routeConfig })).toBe('no-store');
  });
});

describe('PublicCache(maxAgeSec) validation', () => {
  it.each([1, 60, 3600])('accepts %i', (value) => {
    expect(() => PublicCache(value)).not.toThrow();
  });

  it.each([0, -1, 3601, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws RangeError for %s when applied',
    (value) => {
      expect(() => PublicCache(value)).toThrow(RangeError);
    },
  );
});
