import { IS_PUBLIC_KEY } from '../../../common/auth/public.decorator';
import { PUBLIC_CACHE_CONFIG_KEY } from '../../../common/http/public-cache.decorator';
import { CatalogController } from '../catalog.controller';

// Decorator metadata the framework reads at boot; asserting it here pins the rules that the
// HTTP-level suites cannot see (a rate limit has no response header to check).
describe('CatalogController route policy', () => {
  // Read through Reflect: a bare method reference trips the unbound-method lint rule.
  const handlers = (['categories', 'products', 'product'] as const).map(
    (name): object => Reflect.get(CatalogController.prototype, name) as object,
  );

  it('every handler is public and cached for 60 seconds', () => {
    for (const handler of handlers) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata('__fastify_route_config__', handler)).toEqual({
        [PUBLIC_CACHE_CONFIG_KEY]: { maxAgeSec: 60 },
      });
    }
  });

  it('is limited to 600 requests per minute per IP (owner decision Q14)', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', CatalogController)).toBe(600);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', CatalogController)).toBe(60_000);
  });
});
