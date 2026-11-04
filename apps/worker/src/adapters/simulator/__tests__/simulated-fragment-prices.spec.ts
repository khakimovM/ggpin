import { SimulatedFxSource } from '../../../pricing-sync/fx-sources/simulated-fx.source';
import {
  SIMULATED_PREMIUM_NANO_TON,
  SIMULATED_STAR_NANO_TON,
  SimulatedFragmentPrices,
} from '../simulated-fragment-prices';

describe('SimulatedFragmentPrices (fake, dry-run only)', () => {
  const prices = new SimulatedFragmentPrices();

  it('is marked simulated and writes source "simulator" for adapter FRAGMENT', () => {
    expect(prices).toMatchObject({ adapter: 'FRAGMENT', name: 'simulator', simulated: true });
    expect(new SimulatedFxSource()).toMatchObject({ name: 'simulator', simulated: true });
  });

  it('prices a custom-quantity product per unit with one product-level TON row', async () => {
    const lines = await prices.costs({
      productId: 'p',
      allowCustomQty: true,
      skus: [{ id: 's', quantity: 50 }],
    });
    expect(lines).toEqual([
      { skuId: null, basisQuantity: 1, currency: 'TON', costMinor: SIMULATED_STAR_NANO_TON },
    ]);
  });

  it('prices fixed packs per SKU by month count and skips unknown lengths', async () => {
    const lines = await prices.costs({
      productId: 'p',
      allowCustomQty: false,
      skus: [
        { id: 'm12', quantity: 12 },
        { id: 'm1', quantity: 1 },
        { id: 'm3', quantity: 3 },
      ],
    });
    expect(lines).toEqual([
      { skuId: 'm12', basisQuantity: 12, currency: 'TON', costMinor: 9_100_000_000n },
      { skuId: 'm3', basisQuantity: 3, currency: 'TON', costMinor: 3_750_000_000n },
    ]);
  });

  it('is deterministic and has a price for every Premium length (3, 6, 12)', () => {
    expect([...SIMULATED_PREMIUM_NANO_TON.keys()]).toEqual([3, 6, 12]);
    for (const cost of SIMULATED_PREMIUM_NANO_TON.values()) expect(cost > 0n).toBe(true);
  });
});
