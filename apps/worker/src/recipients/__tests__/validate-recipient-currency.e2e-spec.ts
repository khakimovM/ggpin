import { COST_MAX_AGE_MS, MAX_CLOCK_SKEW_MS, type CostCurrency } from '@repo/shared';
import { useRecipientE2e } from './recipient-e2e.harness';
import { username } from './recipient-e2e.fixtures';
import { stubAdapter } from './recipient-test-doubles';

// Phase 5 S9g (D-62 (4), Q-9) on the real database: the recipient check asks only an adapter of
// the currency of the product's newest FRESH cost snapshot, selected by @repo/db's shared read
// (the API price book's window). A real BullMQ Worker answers jobs added like the API adds them.
// Two stub adapters (nothing leaves the process): E2E_TON (TON, DOWN, like a dead Fragment) first
// on the route, E2E_USDT (USDT, healthy, like the reseller) second.

const TON_DOWN = 'E2E_TON';
const USDT_UP = 'E2E_USDT';
const tonValidate = jest.fn(() =>
  Promise.resolve({ status: 'FOUND', providerRef: 'r', displayName: 'T' }),
);
const usdtValidate = jest.fn(() =>
  Promise.resolve({ status: 'FOUND', providerRef: 'ref-1', displayName: 'Aziz' }),
);

const t = useRecipientE2e({
  adapters: [
    stubAdapter(TON_DOWN, { validate: tonValidate, health: () => Promise.resolve('DOWN') }),
    stubAdapter(USDT_UP, { costCurrency: 'USDT', validate: usdtValidate }),
  ],
});

beforeEach(() => {
  tonValidate.mockClear();
  usdtValidate.mockClear();
});

/** A Stars-like product routed E2E_TON first, E2E_USDT second. */
async function product(): Promise<string> {
  const productId = await t.products.create({ adapter: TON_DOWN, allowCustomQty: true });
  await t.db.productRoute.create({ data: { productId, adapter: USDT_UP, priority: 2 } });
  return productId;
}

/** A product-level snapshot stamped `ageMs` ago (negative: in the future). */
function snapshot(productId: string, currency: CostCurrency, ageMs: number, skuId?: string) {
  return t.db.costSnapshot.create({
    data: {
      productId,
      skuId: skuId ?? null,
      adapter: currency === 'TON' ? TON_DOWN : USDT_UP,
      currency,
      basisQuantity: 1,
      costMinor: 1_000n,
      source: 'e2e',
      createdAt: new Date(Date.now() - ageMs),
    },
  });
}

const ask = (productId: string) => t.ask({ productId, input: { username: username('cur_') } });
const FOUND_BY_USDT = { status: 'FOUND', providerRef: `${USDT_UP}:ref-1`, displayName: 'Aziz' };

describe('validate-recipient follows the currency of the current price (S9g)', () => {
  it('fresh TON snapshot, the TON adapter DOWN: UNAVAILABLE, the USDT adapter never asked', async () => {
    const productId = await product();
    await snapshot(productId, 'TON', 60_000);
    await expect(ask(productId)).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(usdtValidate).not.toHaveBeenCalled();
    expect(tonValidate).not.toHaveBeenCalled();
  });

  it('a newer fresh USDT snapshot over an older fresh TON one: the USDT adapter answers', async () => {
    const productId = await product();
    await snapshot(productId, 'TON', 120_000);
    await snapshot(productId, 'USDT', 60_000);
    await expect(ask(productId)).resolves.toEqual(FOUND_BY_USDT);
  });

  it('only a STALE TON snapshot: any currency as before S9g, the USDT adapter answers', async () => {
    const productId = await product();
    // Five seconds past COST_MAX_AGE_MS: the API would not price it (503 PRICE_UNAVAILABLE).
    await snapshot(productId, 'TON', COST_MAX_AGE_MS + 5_000);
    await expect(ask(productId)).resolves.toEqual(FOUND_BY_USDT);
    expect(tonValidate).not.toHaveBeenCalled();
  });

  it('a TON snapshot stamped beyond the clock-skew allowance is ignored, like the API does', async () => {
    const productId = await product();
    await snapshot(productId, 'TON', -(MAX_CLOCK_SKEW_MS + 60_000));
    await expect(ask(productId)).resolves.toEqual(FOUND_BY_USDT);
  });

  it('fixed packs priced in different currencies (failover half done): UNAVAILABLE, nobody asked', async () => {
    // A Premium-like product: fixed packs, routed like the others. The newer pack row is USDT, so
    // without the mixed check the USDT adapter would answer; the older pack is still TON.
    const productId = await t.products.create({ adapter: TON_DOWN });
    await t.db.productRoute.create({ data: { productId, adapter: USDT_UP, priority: 2 } });
    const pack = (quantity: number) =>
      t.db.sku.create({
        data: {
          productId,
          labelUz: `${quantity} oy`,
          labelRu: `${quantity} мес`,
          quantity,
          markupBps: 1_000,
        },
      });
    const [three, six] = [await pack(3), await pack(6)];
    await snapshot(productId, 'TON', 120_000, three.id);
    await snapshot(productId, 'USDT', 60_000, six.id);
    await expect(ask(productId)).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(usdtValidate).not.toHaveBeenCalled();
    expect(tonValidate).not.toHaveBeenCalled();
  });

  it('no snapshot at all: any currency as before S9g', async () => {
    const productId = await product();
    await expect(ask(productId)).resolves.toEqual(FOUND_BY_USDT);
  });
});
