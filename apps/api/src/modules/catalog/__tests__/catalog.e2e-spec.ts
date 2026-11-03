import { useCatalogE2e, type CategoryOut, type ProductOut } from './catalog-e2e.helpers';

describe('GET /catalog/categories and /catalog/products (e2e)', () => {
  const { get, slug, sfx } = useCatalogE2e();

  const mine = (rows: readonly CategoryOut[]) => rows.filter((row) => row.slug.endsWith(sfx));

  describe('GET /catalog/categories', () => {
    it('defaults to Uzbek, sorted by sort, only categories with an active product, with counts', async () => {
      const res = await get('/categories');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mine(res.body.data as CategoryOut[])).toEqual([
        { slug: slug('tg'), name: 'Telegram xizmatlari', productCount: 2 },
        { slug: slug('games'), name: 'O‘yinlar', productCount: 4 },
      ]);
    });

    it('localises with ?locale=ru', async () => {
      const res = await get('/categories?locale=ru');
      expect(mine(res.body.data as CategoryOut[]).map((c) => c.name)).toEqual([
        'Сервисы Telegram',
        'Игры',
      ]);
    });

    it('rejects an unsupported locale and an unknown key with 400 and no-store', async () => {
      for (const query of ['?locale=en', '?locale=', '?lang=ru']) {
        const res = await get(`/categories${query}`);
        expect([query, res.status, res.body.error?.code]).toEqual([query, 400, 'VALIDATION_ERROR']);
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('needs no session and is publicly cacheable for 60 s on a 200', async () => {
      const res = await get('/categories');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    });
  });

  describe('GET /catalog/products', () => {
    it('lists active products of a category in sort order with the list shape', async () => {
      const res = await get(`/products?category=${slug('tg')}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
      const items = res.body.data as Record<string, unknown>[];
      expect(items.map((p) => p['slug'])).toEqual([slug('stars'), slug('premium')]);
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(
        [
          'categorySlug',
          'deliveryType',
          'fromPriceTiyin',
          'id',
          'imageUrl',
          'inStock',
          'isAuto',
          'isFeatured',
          'name',
          'regionBadge',
          'slug',
        ].sort(),
      );
      expect(items[0]).toMatchObject({
        categorySlug: slug('tg'),
        name: 'Telegram Stars',
        deliveryType: 'TG_USERNAME',
        inStock: true,
        // 50 stars x 0.0025 TON x 40 000 so'm = 5 000 so'm, +10% = 5 500 so'm = 550 000 tiyin.
        fromPriceTiyin: '550000',
      });
      // Premium: only the 3-month pack has a cost: 3 TON = 120 000 so'm, +10% = 132 000 so'm.
      expect(items[1]).toMatchObject({ fromPriceTiyin: '13200000' });
    });

    it('names follow ?locale=; brand names are identical in both languages', async () => {
      const uz = (await get(`/products?category=${slug('games')}`)).body.data as ProductOut[];
      const ru = (await get(`/products?category=${slug('games')}&locale=ru`)).body
        .data as ProductOut[];
      expect(uz.map((p) => p.name)).toEqual([
        'Olmos 100% paket',
        'Olmos oddiy',
        'Snake_case o‘yin',
        'Kod',
      ]);
      expect(ru.map((p) => p.name)).toEqual(['Алмазы пакет', 'Алмазы обычные', 'Змея', 'Код']);
      const tgUz = (await get(`/products?category=${slug('tg')}`)).body.data as ProductOut[];
      const tgRu = (await get(`/products?category=${slug('tg')}&locale=ru`)).body
        .data as ProductOut[];
      expect(tgUz.map((p) => p.name)).toEqual(['Telegram Stars', 'Telegram Premium']);
      expect(tgRu.map((p) => p.name)).toEqual(tgUz.map((p) => p.name));
    });

    it('never lists an inactive product and an unknown category is an empty page', async () => {
      const all = (await get(`/products?category=${slug('tg')}&q=Yashirin`)).body;
      expect(all.data).toEqual([]);
      const none = await get('/products?category=no-such-category-xyz');
      expect(none.status).toBe(200);
      expect(none.body.data).toEqual([]);
      expect(none.body.meta).toEqual({ page: 1, limit: 20, total: 0 });
    });

    it('paginates with page and limit', async () => {
      const first = await get(`/products?category=${slug('games')}&limit=3`);
      expect(first.body.meta).toEqual({ page: 1, limit: 3, total: 4 });
      expect((first.body.data as ProductOut[]).length).toBe(3);
      const second = await get(`/products?category=${slug('games')}&limit=3&page=2`);
      expect((second.body.data as ProductOut[]).map((p) => p.name)).toEqual(['Kod']);
    });

    it('rejects limit above 100, bad paging, bad slug, bad locale and unknown keys with 400', async () => {
      for (const query of [
        'limit=101',
        'limit=0',
        'page=0',
        'category=Bad_Slug',
        'locale=en',
        'sort=asc',
        `q=${'a'.repeat(65)}`,
      ]) {
        const res = await get(`/products?${query}`);
        expect([query, res.status]).toEqual([query, 400]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
      expect((await get('/products?limit=100')).status).toBe(200);
    });

    describe('search (?q=)', () => {
      const search = async (q: string, locale = 'uz'): Promise<string[]> => {
        const res = await get(
          `/products?category=${slug('games')}&locale=${locale}&q=${encodeURIComponent(q)}`,
        );
        expect(res.status).toBe(200);
        return (res.body.data as ProductOut[]).map((p) => p.name);
      };

      it('matches the Uzbek name, ignoring case', async () => {
        expect(await search('olmos')).toEqual(['Olmos 100% paket', 'Olmos oddiy']);
        expect(await search('OLMOS')).toEqual(['Olmos 100% paket', 'Olmos oddiy']);
      });

      it('matches the Russian name, whatever locale the names are shown in', async () => {
        expect(await search('Алмазы')).toEqual(['Olmos 100% paket', 'Olmos oddiy']);
        expect(await search('Алмазы', 'ru')).toEqual(['Алмазы пакет', 'Алмазы обычные']);
        expect(await search('змея', 'ru')).toEqual(['Змея']);
      });

      it('treats % and _ as literal characters, not wildcards', async () => {
        expect(await search('%')).toEqual(['Olmos 100% paket']);
        expect(await search('100%')).toEqual(['Olmos 100% paket']);
        expect(await search('_')).toEqual(['Snake_case o‘yin']);
        expect(await search('\\')).toEqual([]);
        expect(await search('o_mos')).toEqual([]);
      });

      it('an empty or blank q means no filter and a miss is an empty page', async () => {
        expect((await search('')).length).toBe(4);
        expect((await search('   ')).length).toBe(4);
        expect(await search('zzzz-no-match')).toEqual([]);
      });

      it('searches active products only', async () => {
        const res = await get(
          `/products?category=${slug('tg')}&q=${encodeURIComponent('Скрытый')}`,
        );
        expect(res.body.data).toEqual([]);
      });
    });

    it('voucher products report inStock from available inventory', async () => {
      const res = await get(`/products?category=${slug('games')}`);
      const voucher = (res.body.data as ProductOut[]).find((p) => p.slug === slug('voucher'));
      expect(voucher?.inStock).toBe(true);
    });
  });
});
