import type { AdapterHealth, RecipientCheckRequest } from '@repo/shared';
import { AdapterRouter } from '../../fulfillment/adapter-router';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { RecipientLookupService } from '../recipient-lookup.service';
import type { ProductPricedBy, RecipientProductRepository } from '../recipient-product.repository';
import { FOUND, PRODUCT_ID } from './processor-harness';
import { TG_USERNAME_FORM, stubAdapter } from './recipient-test-doubles';

// Phase 5 S9g (D-62 (4), Q-9): the recipient check asks only an adapter that charges in the
// currency of the product's newest fresh cost snapshot, i.e. one that can fulfil the order the
// check leads to. Fragment (TON) DOWN while new quotes are still priced in TON -> UNAVAILABLE,
// never the USDT backup; no fresh snapshot -> any currency, as before S9g.

const BUDGET = 1_000;
const MIN_CALL = 50;
const REQUEST: RecipientCheckRequest = { productId: PRODUCT_ID, input: { username: 'aziz_k' } };
const RESELLER = 'RESELLER_STARS';

const TON: ProductPricedBy = {
  kind: 'priced',
  snapshotId: 'cs_ton',
  adapter: 'FRAGMENT',
  currency: 'TON',
};
const USDT: ProductPricedBy = {
  kind: 'priced',
  snapshotId: 'cs_usdt',
  adapter: RESELLER,
  currency: 'USDT',
};

interface Options {
  readonly pricedBy: () => Promise<ProductPricedBy | null>;
  readonly fragment?: AdapterHealth;
  readonly reseller?: AdapterHealth;
}

function setup(options: Options) {
  const product = {
    id: PRODUCT_ID,
    slug: 'stars',
    isActive: true,
    allowCustomQty: true,
    inputSchema: TG_USERNAME_FORM,
    skus: [],
  };
  const pricedBy = jest.fn(options.pricedBy);
  const products = {
    find: jest.fn(() => Promise.resolve(product)),
    pricedBy,
  } as unknown as RecipientProductRepository;
  // Fragment first, the backup second: the order of the seeded Stars routes.
  const findMany = jest.fn(() => Promise.resolve([{ adapter: 'FRAGMENT' }, { adapter: RESELLER }]));
  const prisma = { client: { productRoute: { findMany } } } as unknown as PrismaService;
  const fragmentValidate = jest.fn(() => Promise.resolve(FOUND));
  const resellerValidate = jest.fn(() => Promise.resolve(FOUND));
  const fragment = stubAdapter('FRAGMENT', {
    validate: fragmentValidate,
    health: () => Promise.resolve(options.fragment ?? 'OK'),
  });
  const reseller = stubAdapter(RESELLER, {
    costCurrency: 'USDT',
    validate: resellerValidate,
    health: () => Promise.resolve(options.reseller ?? 'OK'),
  });
  const router = new AdapterRouter(
    prisma,
    new Map([
      [fragment.code, fragment],
      [reseller.code, reseller],
    ]),
  );
  router['logger'].warn = jest.fn();
  const lookup = new RecipientLookupService(products, router);
  return { lookup, pricedBy, fragmentValidate, resellerValidate, product };
}

describe('RecipientLookupService: the adapter of the current price currency (S9g)', () => {
  it('priced in TON, Fragment DOWN, backup healthy: UNAVAILABLE (NO_ADAPTER), nobody asked', async () => {
    const s = setup({ pricedBy: () => Promise.resolve(TON), fragment: 'DOWN' });
    await expect(s.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toEqual({
      kind: 'RESULT',
      result: { status: 'UNAVAILABLE' },
      reason: 'NO_ADAPTER',
      adapter: null,
    });
    expect(s.resellerValidate).not.toHaveBeenCalled();
    expect(s.fragmentValidate).not.toHaveBeenCalled();
  });

  it('priced in USDT by the backup, Fragment healthy and first: the backup answers', async () => {
    const s = setup({ pricedBy: () => Promise.resolve(USDT) });
    await expect(s.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toEqual({
      kind: 'RESULT',
      result: { ...FOUND, providerRef: `${RESELLER}:ref-1` },
      reason: 'ANSWERED',
      adapter: RESELLER,
    });
    expect(s.fragmentValidate).not.toHaveBeenCalled();
  });

  it('priced in USDT, the backup DOWN: UNAVAILABLE, Fragment (TON) is not asked', async () => {
    const s = setup({ pricedBy: () => Promise.resolve(USDT), reseller: 'DOWN' });
    await expect(s.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toMatchObject({
      result: { status: 'UNAVAILABLE' },
      reason: 'NO_ADAPTER',
    });
    expect(s.fragmentValidate).not.toHaveBeenCalled();
    expect(s.resellerValidate).not.toHaveBeenCalled();
  });

  it('packs priced in different currencies: UNAVAILABLE (NO_ADAPTER), nobody asked', async () => {
    const mixed: ProductPricedBy = { kind: 'mixed', currencies: ['USDT', 'TON'] };
    // Both adapters healthy: any of them would answer, and still neither may.
    const s = setup({ pricedBy: () => Promise.resolve(mixed) });
    await expect(s.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toEqual({
      kind: 'RESULT',
      result: { status: 'UNAVAILABLE' },
      reason: 'NO_ADAPTER',
      adapter: null,
    });
    expect(s.fragmentValidate).not.toHaveBeenCalled();
    expect(s.resellerValidate).not.toHaveBeenCalled();
  });

  it('priced in TON, Fragment healthy: Fragment answers', async () => {
    const s = setup({ pricedBy: () => Promise.resolve(TON) });
    await expect(s.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toMatchObject({
      reason: 'ANSWERED',
      adapter: 'FRAGMENT',
    });
    expect(s.resellerValidate).not.toHaveBeenCalled();
  });

  it('no fresh snapshot (none or stale): any currency as before S9g, the backup answers', async () => {
    const s = setup({ pricedBy: () => Promise.resolve(null), fragment: 'DOWN' });
    await expect(s.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toMatchObject({
      result: { status: 'FOUND', providerRef: `${RESELLER}:ref-1` },
      reason: 'ANSWERED',
      adapter: RESELLER,
    });
  });

  it('asks for the snapshot of this product at the current time', async () => {
    const s = setup({ pricedBy: () => Promise.resolve(TON) });
    const before = Date.now();
    await s.lookup.check(REQUEST, BUDGET, MIN_CALL);
    expect(s.pricedBy).toHaveBeenCalledTimes(1);
    const [product, now] = s.pricedBy.mock.calls[0] as unknown as [unknown, Date];
    expect(product).toBe(s.product);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a snapshot read that hangs is a TIMEOUT; one that throws is an ERROR; no provider asked', async () => {
    const hangs = setup({ pricedBy: () => new Promise<never>(() => undefined) });
    await expect(hangs.lookup.check(REQUEST, 100, 10)).resolves.toMatchObject({
      result: { status: 'UNAVAILABLE' },
      reason: 'TIMEOUT',
    });
    const throws = setup({ pricedBy: () => Promise.reject(new TypeError('db down')) });
    await expect(throws.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toMatchObject({
      result: { status: 'UNAVAILABLE' },
      reason: 'ERROR',
      errorName: 'TypeError',
    });
    for (const s of [hangs, throws]) {
      expect(s.fragmentValidate).not.toHaveBeenCalled();
      expect(s.resellerValidate).not.toHaveBeenCalled();
    }
  });
});
