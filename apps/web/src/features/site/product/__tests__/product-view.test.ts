import { describe, expect, it } from 'vitest';
import { buildProductView, productFacts } from '../product-view';
import { seoProduct } from '../seo-products';
import { NOT_FOUND, ok, PREMIUM, STARS, UNAVAILABLE } from './product-kit';

const stars = seoProduct('telegram-stars');
const premium = seoProduct('telegram-premium');

describe('buildProductView: the four states', () => {
  it('ok: the packages with the server prices, as strings', () => {
    const view = buildProductView(ok(STARS), stars);
    expect(view.state).toBe('ok');
    expect(view.packages.map((item) => [item.label, item.priceTiyin])).toEqual([
      ['50 ⭐', '1100000'],
      ['500 ⭐', '11000000'],
      ['1000 ⭐', '22000000'],
    ]);
    expect(view.unitPriceTiyin).toBe('22000');
    expect(view.minQty).toBe(50);
    expect(view.customQty).toBe(true);
    expect(view.auto).toBe(true);
  });

  it('a package with no fresh price (null) or a zero price has no price, never "free"', () => {
    const view = buildProductView(
      ok({
        ...PREMIUM,
        skus: [
          { id: 'a', label: 'a', quantity: 1, tab: null, fromPriceTiyin: null },
          { id: 'b', label: 'b', quantity: 2, tab: null, fromPriceTiyin: '0' },
        ],
      }),
      premium,
    );
    expect(view.packages.map((item) => item.priceTiyin)).toEqual([null, null]);
  });

  it('no packages: the state says so and keeps what is known', () => {
    const view = buildProductView(ok({ ...STARS, skus: [] }), stars);
    expect(view.state).toBe('no-packages');
    expect(view.packages).toEqual([]);
    expect(view.minQty).toBe(50);
  });

  it('unavailable: nothing from the catalog, and delivery from the registry', () => {
    const view = buildProductView(UNAVAILABLE, stars);
    expect(view).toMatchObject({
      state: 'unavailable',
      auto: true,
      regionBadge: null,
      packages: [],
      unitPriceTiyin: null,
      minQty: null,
      customQty: false,
    });
  });

  it('not found: nothing, and no promise of delivery', () => {
    expect(buildProductView(NOT_FOUND, stars)).toMatchObject({
      state: 'not-found',
      auto: false,
      packages: [],
    });
  });

  it('a custom amount is offered only with a minimum to name', () => {
    const view = buildProductView(
      ok({ ...STARS, minQty: null, maxQty: null, allowCustomQty: false }),
      stars,
    );
    expect(view.customQty).toBe(false);
  });

  it('the region badge comes from the API', () => {
    expect(buildProductView(ok({ ...STARS, regionBadge: 'GLOBAL' }), stars).regionBadge).toBe(
      'GLOBAL',
    );
  });
});

describe('productFacts: a card only when there is something to say', () => {
  it('Stars, filled: price per star, minimum, delivery', () => {
    expect(productFacts(buildProductView(ok(STARS), stars), stars)).toEqual([
      { kind: 'unitPrice', tiyin: '22000' },
      { kind: 'min', quantity: 50 },
      { kind: 'delivery' },
    ]);
  });

  it('Stars with null unit price and null minimum: only the delivery card', () => {
    const view = buildProductView(ok({ ...STARS, unitPriceTiyin: null, minQty: null }), stars);
    expect(productFacts(view, stars)).toEqual([{ kind: 'delivery' }]);
  });

  it('a zero unit price is not a card', () => {
    const view = buildProductView(ok({ ...STARS, unitPriceTiyin: '0' }), stars);
    expect(productFacts(view, stars).map((fact) => fact.kind)).toEqual(['min', 'delivery']);
  });

  it('Premium: the number of plans, delivery and the recipient', () => {
    expect(productFacts(buildProductView(ok(PREMIUM), premium), premium)).toEqual([
      { kind: 'plans', count: 2 },
      { kind: 'delivery' },
      { kind: 'recipient' },
    ]);
  });

  it('not auto: no delivery card (the page does not promise what the API does not)', () => {
    const view = buildProductView(ok({ ...STARS, isAuto: false }), stars);
    expect(productFacts(view, stars).map((fact) => fact.kind)).not.toContain('delivery');
  });

  it('catalog unavailable: only what the registry can say without it', () => {
    expect(productFacts(buildProductView(UNAVAILABLE, stars), stars)).toEqual([
      { kind: 'delivery' },
    ]);
    expect(productFacts(buildProductView(UNAVAILABLE, premium), premium)).toEqual([
      { kind: 'delivery' },
      { kind: 'recipient' },
    ]);
  });

  it('a product the catalog does not know has no cards', () => {
    expect(productFacts(buildProductView(NOT_FOUND, stars), stars)).toEqual([]);
  });
});
