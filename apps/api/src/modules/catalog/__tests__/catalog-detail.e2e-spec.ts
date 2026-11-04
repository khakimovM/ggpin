import { useCatalogE2e, type DetailOut, type ProductOut } from './catalog-e2e.helpers';

describe('GET /catalog/products/:slug and price freshness (e2e)', () => {
  const { get, slug, setNow, base, stalePointMs } = useCatalogE2e();

  describe('GET /catalog/products/:slug', () => {
    it('returns the detail in Uzbek by default', async () => {
      const res = await get(`/products/${slug('stars')}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const data = res.body.data as DetailOut;
      expect(data).toMatchObject({
        slug: slug('stars'),
        name: 'Telegram Stars',
        description: 'Telegram Stars: tavsif',
        help: 'Yordam matni',
        deliveryType: 'TG_USERNAME',
        regionBadge: 'GLOBAL',
        isAuto: true,
        allowCustomQty: true,
        minQty: 50,
        maxQty: 100_000,
        inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
        stock: null,
        currency: 'UZS',
        unitPriceTiyin: '11000',
      });
      // Active packs only, smallest first, prices as strings.
      expect(data.skus).toMatchObject([
        { label: '50 ⭐', quantity: 50, tab: null, fromPriceTiyin: '550000' },
        { label: '100 ⭐', quantity: 100, tab: null, fromPriceTiyin: '1100000' },
      ]);
      expect(Object.keys(res.body.data as object).sort()).toEqual(
        [
          'allowCustomQty',
          'currency',
          'deliveryType',
          'description',
          'help',
          'id',
          'imageUrl',
          'inputSchema',
          'isAuto',
          'maxQty',
          'minQty',
          'name',
          'regionBadge',
          'skus',
          'slug',
          'stock',
          'unitPriceTiyin',
        ].sort(),
      );
    });

    it('localises name, description, help and SKU labels with ?locale=ru', async () => {
      const data = (await get(`/products/${slug('stars')}?locale=ru`)).body.data as DetailOut;
      expect(data.description).toBe('Telegram Stars: описание');
      expect(data.help).toBe('Текст помощи');
      expect(data.skus.map((s) => s.label)).toEqual(['50 ⭐ звёзд', '100 ⭐ звёзд']);
      expect(data.name).toBe('Telegram Stars');
      const premium = (await get(`/products/${slug('premium')}?locale=ru`)).body.data as DetailOut;
      expect(premium.skus.map((s) => s.label)).toEqual(['3 месяца', '6 месяцев']);
    });

    it('a pack without a cost has a null price while its sibling has one', async () => {
      const data = (await get(`/products/${slug('premium')}`)).body.data as DetailOut;
      expect(data.skus.map((s) => s.fromPriceTiyin)).toEqual(['13200000', null]);
    });

    it('voucher stock counts only AVAILABLE codes', async () => {
      const data = (await get(`/products/${slug('voucher')}`)).body.data as DetailOut;
      expect(data.stock).toBe(2);
    });

    it('an inactive or unknown product is 404 NOT_FOUND with no-store', async () => {
      for (const name of [slug('hidden'), slug('only-inactive'), 'no-such-product-xyz']) {
        const res = await get(`/products/${name}`);
        expect([name, res.status, res.body.error?.code]).toEqual([name, 404, 'NOT_FOUND']);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('a malformed slug or locale is 400 with no-store', async () => {
      for (const path of [
        '/products/Bad_Slug',
        `/products/${slug('stars')}?locale=en`,
        `/products/${slug('stars')}?x=1`,
      ]) {
        const res = await get(path);
        expect([path, res.status]).toEqual([path, 400]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });
  });

  describe('price freshness (clock moved, rows are immutable)', () => {
    it('prices are still shown at exactly 30:00 and null from 30:00.001', async () => {
      setNow(new Date(base.getTime() + stalePointMs));
      const atLimit = (await get(`/products/${slug('stars')}`)).body.data as DetailOut;
      expect(atLimit.skus.map((s) => s.fromPriceTiyin)).toEqual(['550000', '1100000']);
      expect(atLimit.unitPriceTiyin).toBe('11000');

      setNow(new Date(base.getTime() + stalePointMs + 1));
      const stale = (await get(`/products/${slug('stars')}`)).body.data as DetailOut;
      expect(stale.skus.map((s) => s.fromPriceTiyin)).toEqual([null, null]);
      expect(stale.unitPriceTiyin).toBeNull();
      const list = (await get(`/products?category=${slug('tg')}`)).body.data as ProductOut[];
      expect(list.map((p) => p.fromPriceTiyin)).toEqual([null, null]);
    });

    it('a stale price never turns the response into an error or a cache miss', async () => {
      setNow(new Date(base.getTime() + stalePointMs + 1));
      const res = await get(`/products/${slug('stars')}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });
  });
});
