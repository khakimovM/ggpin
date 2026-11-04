import {
  NOW,
  failure,
  fx,
  pack,
  priceBook,
  request,
  silenceRefusalLogs,
  snapshot,
} from './price-book.fixtures';

silenceRefusalLogs();

describe('PriceBookService.price', () => {
  describe('simulated data (owner decision Q15: refused only in production)', () => {
    const simulatedCost = { rates: [fx()], snapshots: [snapshot({ source: 'simulator' })] };
    const simulatedFx = { rates: [fx({ source: 'simulator' })], snapshots: [snapshot()] };

    it('is accepted outside production', async () => {
      await expect(priceBook(simulatedCost).price(request())).resolves.toBeDefined();
      await expect(priceBook(simulatedFx).price(request())).resolves.toBeDefined();
      await expect(
        priceBook(simulatedFx, { NODE_ENV: 'development' }).price(request()),
      ).resolves.toBeDefined();
    });

    it('a simulator cost snapshot is refused in production', async () => {
      const book = priceBook(simulatedCost, { NODE_ENV: 'production' });
      expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it('a simulator FX rate is refused in production', async () => {
      const book = priceBook(simulatedFx, { NODE_ENV: 'production' });
      expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
    });

    it('real data is accepted in production', async () => {
      const book = priceBook(
        { rates: [fx({ source: 'cbu' })], snapshots: [snapshot({ source: 'fragment' })] },
        { NODE_ENV: 'production' },
      );
      await expect(book.price(request())).resolves.toBeDefined();
    });

    describe('PRICING_ALLOW_SIMULATED=false (development without the opt-in)', () => {
      const off = { NODE_ENV: 'development', PRICING_ALLOW_SIMULATED: false } as const;

      it('refuses a simulator cost snapshot and a simulator FX rate', async () => {
        for (const inputs of [simulatedCost, simulatedFx]) {
          const book = priceBook(inputs, off);
          expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
        }
      });

      it('refuses a TON_UZS derived from a simulator parent', async () => {
        const book = priceBook(
          {
            rates: [
              fx({ source: 'derived:p_ton*p_usdt' }),
              fx({ id: 'p_ton', pair: 'TON_USDT', rate: '3.3333', source: 'simulator' }),
              fx({ id: 'p_usdt', pair: 'USDT_UZS', rate: '12000', source: 'cbu' }),
            ],
            snapshots: [snapshot()],
          },
          off,
        );
        expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
      });

      it('still accepts real data', async () => {
        const book = priceBook(
          { rates: [fx({ source: 'cbu' })], snapshots: [snapshot({ source: 'fragment' })] },
          off,
        );
        await expect(book.price(request())).resolves.toBeDefined();
      });

      it('the catalog shows no price for simulated data either', async () => {
        const skus = [pack()];
        const prices = await priceBook(simulatedCost, off).displayPrices(
          [{ id: 'p_stars', skus }],
          NOW,
        );
        expect(prices.get('p_stars')?.fromPriceTiyin).toBeNull();
      });
    });

    // loadEnv refuses the flag in production, but the price book must not rely on that alone.
    it('PRICING_ALLOW_SIMULATED=true cannot allow simulated data when NODE_ENV is production', async () => {
      for (const inputs of [simulatedCost, simulatedFx]) {
        const book = priceBook(inputs, { NODE_ENV: 'production', PRICING_ALLOW_SIMULATED: true });
        expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
      }
    });

    describe('derived TON_UZS must name exactly TON_USDT then USDT_UZS (distinct, plain parents)', () => {
      const tonUsdt = fx({ id: 'p_ton', pair: 'TON_USDT', rate: '3.3333', source: 'binance' });
      const usdtUzs = fx({ id: 'p_usdt', pair: 'USDT_UZS', rate: '12000', source: 'cbu' });
      const otherUsdtUzs = fx({ id: 'p_usdt2', pair: 'USDT_UZS', rate: '12000', source: 'cbu' });
      const off = { NODE_ENV: 'development', PRICING_ALLOW_SIMULATED: false } as const;

      it.each([
        ['the same parent twice', 'derived:p_ton*p_ton', [tonUsdt, usdtUzs]],
        ['the same USDT_UZS parent twice', 'derived:p_usdt*p_usdt', [tonUsdt, usdtUzs]],
        ['the parents in the wrong order', 'derived:p_usdt*p_ton', [tonUsdt, usdtUzs]],
        ['two USDT_UZS parents', 'derived:p_usdt*p_usdt2', [tonUsdt, usdtUzs, otherUsdtUzs]],
      ])('fails closed for %s', async (_label, source, rows) => {
        for (const config of [off, { NODE_ENV: 'production' } as const]) {
          const book = priceBook(
            { rates: [fx({ source }), ...rows], snapshots: [snapshot()] },
            config,
          );
          expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
        }
      });

      it('fails closed when a non TON_UZS row claims to be derived', async () => {
        const book = priceBook(
          {
            rates: [
              fx({ id: 'fx_usdt', pair: 'USDT_UZS', source: 'derived:p_ton*p_usdt' }),
              tonUsdt,
              usdtUzs,
            ],
            snapshots: [snapshot({ currency: 'USDT', costMinor: 4_000_000n })],
          },
          off,
        );
        expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
      });

      it('accepts the well-formed derivation', async () => {
        const book = priceBook(
          {
            rates: [fx({ source: 'derived:p_ton*p_usdt' }), tonUsdt, usdtUzs],
            snapshots: [snapshot()],
          },
          off,
        );
        await expect(book.price(request())).resolves.toBeDefined();
      });
    });

    describe('derived TON_UZS', () => {
      const parents = (usdtUzs: string, tonUsdt: string) => [
        fx({ id: 'p_usdt', pair: 'USDT_UZS', rate: '12000', source: usdtUzs }),
        fx({ id: 'p_ton', pair: 'TON_USDT', rate: '3.3333', source: tonUsdt }),
      ];
      const derived = fx({ source: 'derived:p_ton*p_usdt' });

      it('built from a simulator parent is refused in production', async () => {
        for (const rows of [parents('cbu', 'simulator'), parents('simulator', 'binance')]) {
          const book = priceBook(
            { rates: [derived, ...rows], snapshots: [snapshot()] },
            { NODE_ENV: 'production' },
          );
          expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
        }
      });

      it('built from real parents is accepted in production', async () => {
        const book = priceBook(
          { rates: [derived, ...parents('cbu', 'binance')], snapshots: [snapshot()] },
          { NODE_ENV: 'production' },
        );
        await expect(book.price(request())).resolves.toBeDefined();
      });

      it('is accepted outside production even from simulator parents', async () => {
        const book = priceBook({
          rates: [derived, ...parents('simulator', 'simulator')],
          snapshots: [snapshot()],
        });
        await expect(book.price(request())).resolves.toBeDefined();
      });

      it.each([
        ['an unparsable source', 'derived:garbage', parents('cbu', 'binance')],
        ['a missing parent', 'derived:p_ton*p_gone', parents('cbu', 'binance')],
        ['a parent that is itself derived', 'derived:p_ton*p_usdt', parents('derived:a*b', 'x')],
      ])('fails closed in production for %s', async (_label, source, rows) => {
        const book = priceBook(
          { rates: [fx({ source }), ...rows], snapshots: [snapshot()] },
          { NODE_ENV: 'production' },
        );
        expect((await failure(book.price(request()))).code).toBe('PRICE_UNAVAILABLE');
      });
    });
  });
});
