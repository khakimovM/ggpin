import { buildQuoteFixtures } from './quotes-e2e.fixtures';
import { useQuotesE2e } from './quotes-e2e.helpers';

describe('POST /quotes rejections (e2e)', () => {
  const t = useQuotesE2e(buildQuoteFixtures);
  const quoteCount = (userId: string) => t.db.quote.count({ where: { userId } });

  // Every rejection must write nothing and be uncacheable.
  async function reject(
    body: Record<string, unknown>,
    expected: { status: number; code: string; details?: unknown },
    productFor: 'stars' | 'premium' = 'stars',
  ) {
    const f = t.fixtures();
    const user = await t.newUser();
    const tokenProduct = body['productId'] === f[productFor].id ? f[productFor].id : f.stars.id;
    const recipientToken = await t.token(user.id, tokenProduct);
    const res = await t.post({ recipientToken, ...body }, user);
    expect([res.status, res.body.error?.code]).toEqual([expected.status, expected.code]);
    if (expected.details !== undefined) expect(res.body.error?.details).toEqual(expected.details);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await quoteCount(user.id)).toBe(0);
  }

  describe('product and pack', () => {
    it('unknown product -> 404 NOT_FOUND', async () => {
      await reject(
        { productId: 'no-such-product', quantity: 50 },
        { status: 404, code: 'NOT_FOUND' },
      );
    });

    it('inactive product -> 422 PRODUCT_UNAVAILABLE', async () => {
      const f = t.fixtures();
      await reject(
        { productId: f.inactive.id, skuId: f.inactive.sku[50] },
        { status: 422, code: 'PRODUCT_UNAVAILABLE' },
      );
    });

    it('inactive pack, unknown pack and a pack of another product -> 422 PRODUCT_UNAVAILABLE', async () => {
      const f = t.fixtures();
      for (const skuId of [f.stars.sku[500], 'no-such-sku', f.premium.sku[3]]) {
        await reject(
          { productId: f.stars.id, skuId },
          { status: 422, code: 'PRODUCT_UNAVAILABLE' },
        );
      }
    });
  });

  describe('custom quantity', () => {
    it('below min and above max -> 422 QTY_OUT_OF_RANGE with {min, max}', async () => {
      const f = t.fixtures();
      for (const quantity of [49, 1001]) {
        await reject(
          { productId: f.stars.id, quantity },
          { status: 422, code: 'QTY_OUT_OF_RANGE', details: { min: 50, max: 1000 } },
        );
      }
    });

    it('the bounds themselves are accepted', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      for (const quantity of [50, 1000]) {
        const recipientToken = await t.token(user.id, f.stars.id);
        const res = await t.post({ productId: f.stars.id, quantity, recipientToken }, user);
        expect([quantity, res.status]).toEqual([quantity, 201]);
      }
    });

    it('custom quantity on a fixed-pack product -> 422 with null bounds', async () => {
      const f = t.fixtures();
      await reject(
        { productId: f.premium.id, quantity: 3 },
        { status: 422, code: 'QTY_OUT_OF_RANGE', details: { min: null, max: null } },
        'premium',
      );
    });
  });

  describe('body validation', () => {
    it('skuId and quantity together, or neither -> 400 VALIDATION_ERROR', async () => {
      const f = t.fixtures();
      await reject(
        { productId: f.stars.id, skuId: f.stars.sku[50], quantity: 50 },
        { status: 400, code: 'VALIDATION_ERROR' },
      );
      await reject({ productId: f.stars.id }, { status: 400, code: 'VALIDATION_ERROR' });
    });

    it('an unknown key, a bad quantity or a malformed token -> 400', async () => {
      const f = t.fixtures();
      const bad = { status: 400, code: 'VALIDATION_ERROR' };
      await reject({ productId: f.stars.id, skuId: f.stars.sku[50], userId: 'x' }, bad);
      await reject({ productId: f.stars.id, quantity: 0 }, bad);
      await reject({ productId: f.stars.id, quantity: 50.5 }, bad);
      await reject({ productId: f.stars.id, quantity: '50' }, bad);
      await reject({ productId: f.stars.id, skuId: f.stars.sku[50], recipientToken: 'short' }, bad);
    });

    // Postgres refuses a NUL byte in text, which used to surface as a 500 and an error log.
    it('a control character in an id or the discount code -> 400 VALIDATION_ERROR, not 500', async () => {
      const f = t.fixtures();
      const bad = { status: 400, code: 'VALIDATION_ERROR' };
      await reject({ productId: 'ab\u0000cd', quantity: 50 }, bad);
      await reject({ productId: 'ab\u0000cd', skuId: f.stars.sku[50] }, bad);
      await reject({ productId: f.stars.id, skuId: `${f.stars.sku[50]}\u0000` }, bad);
      await reject(
        { productId: f.stars.id, skuId: f.stars.sku[50], discountCode: 'SA\u0000LE' },
        bad,
      );
    });

    it('a discount code -> 422 CODE_INVALID (codes arrive in phase 10)', async () => {
      const f = t.fixtures();
      await reject(
        { productId: f.stars.id, skuId: f.stars.sku[50], discountCode: 'SALE10' },
        { status: 422, code: 'CODE_INVALID' },
      );
    });
  });
});
