import { PREMIUM_MONTHS, RecipientCheckResultSchema } from '@repo/shared';
import type { PrepareContext } from '../../fulfillment-adapter';
import { SIMULATED_PREMIUM_NANO_TON, SIMULATED_STAR_NANO_TON } from '../simulated-fragment-prices';
import { SimulatedFragmentAdapter, simulatedFragmentCost } from '../simulated-fragment.adapter';
import { SimulatedResellerAdapter } from '../simulated-reseller.adapter';
import {
  SIM_SCENARIOS,
  SimulatorScript,
  simulatedProviderRef,
  simulatedRecipientProblem,
  simulatedValidation,
} from '../simulator-script';

// Phase 6 S1: the simulators tell Stars from Premium by the product's slug (owner Q4), never by
// the SKU size; Premium is 3, 6 or 12 months only; `haspremium_*` / `premiumext_*` answer for
// Premium only; scenario GOT_PREMIUM refuses the recipient at prepare (Premium after the quote).

const DRY = { NODE_ENV: 'test', FULFILLMENT_DRY_RUN: true };
const PREMIUM = { id: 'p-prem', slug: 'telegram-premium' };
const STARS = { id: 'p-stars', slug: 'telegram-stars' };

function context(
  orderId: string,
  product: { id: string; slug: string },
  sku: { id: string | null; quantity: number },
  username = 'alice',
): PrepareContext {
  return {
    orderId,
    attemptNo: 1,
    product,
    sku,
    recipient: { fields: { username }, providerRef: simulatedProviderRef(username) },
  };
}

describe('simulatedFragmentCost: by product kind, not by pack size', () => {
  it('the price table has exactly the sold Premium terms (PREMIUM_MONTHS), in order', () => {
    expect([...SIMULATED_PREMIUM_NANO_TON.keys()]).toEqual([...PREMIUM_MONTHS]);
  });

  it('Premium 3/6/12 months cost their pack price', () => {
    for (const months of [3, 6, 12]) {
      expect(simulatedFragmentCost('PREMIUM', { id: `m${String(months)}`, quantity: months })).toBe(
        SIMULATED_PREMIUM_NANO_TON.get(months),
      );
    }
  });

  it('Premium of any other length, or without a SKU, has no price', () => {
    for (const quantity of [1, 2, 4, 9, 24]) {
      expect(simulatedFragmentCost('PREMIUM', { id: 'm', quantity })).toBeNull();
    }
    expect(simulatedFragmentCost('PREMIUM', { id: null, quantity: 3 })).toBeNull();
  });

  it('a Stars pack of 3, 6 or 12 is priced per Star (regression: never as Premium)', () => {
    for (const kind of ['STARS', null] as const) {
      for (const quantity of [3, 6, 12, 50]) {
        expect(simulatedFragmentCost(kind, { id: 'sku', quantity })).toBe(
          SIMULATED_STAR_NANO_TON * BigInt(quantity),
        );
      }
    }
  });
});

describe('simulated Fragment: Premium prepare and quote', () => {
  const script = new SimulatorScript();
  const fragment = new SimulatedFragmentAdapter(DRY, script);

  it('a 12-month Premium order is READY at the 12-month price; a 12-pack of Stars at 12 Stars', async () => {
    const premium = await fragment.prepare(context('o-p12', PREMIUM, { id: 's12', quantity: 12 }));
    expect(premium.status === 'READY' && premium.prepared.costMinor).toBe(9_100_000_000n);
    const stars = await fragment.prepare(context('o-s12', STARS, { id: 's12', quantity: 12 }));
    expect(stars.status === 'READY' && stars.prepared.costMinor).toBe(
      SIMULATED_STAR_NANO_TON * 12n,
    );
  });

  it('a Premium line outside 3/6/12 is REFUSED at prepare (HELD, never paid) and has no quote', async () => {
    const line = { id: 's4', quantity: 4 };
    expect(await fragment.prepare(context('o-p4', PREMIUM, line))).toEqual({
      status: 'REFUSED',
      reason: 'simulated: not a Premium term',
    });
    await expect(fragment.quote(PREMIUM, line)).rejects.toThrow('no simulated price');
    await expect(fragment.quote(PREMIUM, { id: 's6', quantity: 6 })).resolves.toEqual({
      currency: 'TON',
      costMinor: 5_000_000_000n,
    });
  });

  it('GOT_PREMIUM: RECIPIENT_REFUSED at prepare (both simulators), validation still FOUND', async () => {
    script.set('o-got', 'GOT_PREMIUM');
    const line = { id: 's3', quantity: 3 };
    expect(await fragment.prepare(context('o-got', PREMIUM, line))).toEqual({
      status: 'RECIPIENT_REFUSED',
    });
    const reseller = new SimulatedResellerAdapter(DRY, script);
    expect(await reseller.prepare(context('o-got', STARS, { id: null, quantity: 50 }))).toEqual({
      status: 'RECIPIENT_REFUSED',
    });
    await expect(
      simulatedValidation('GOT_PREMIUM', { username: 'alice' }, undefined, 'PREMIUM'),
    ).resolves.toMatchObject({ status: 'FOUND' });
  });

  it('a haspremium_ recipient of a Premium order is RECIPIENT_REFUSED; of a Stars order it is paid', async () => {
    const name = 'haspremium_bob';
    const premium = await fragment.prepare(
      context('o-h', PREMIUM, { id: 's3', quantity: 3 }, name),
    );
    expect(premium).toEqual({ status: 'RECIPIENT_REFUSED' });
    const stars = await fragment.prepare(context('o-h', STARS, { id: null, quantity: 50 }, name));
    expect(stars.status).toBe('READY');
  });
});

describe('simulated validation: Premium prefixes (Premium only, scenario OK)', () => {
  const script = new SimulatorScript();
  const adapters = [
    new SimulatedFragmentAdapter(DRY, script),
    new SimulatedResellerAdapter(DRY, script),
  ];

  it('Premium: haspremium_ REFUSED HAS_PREMIUM, premiumext_ FOUND + PREMIUM_EXTENDS', async () => {
    for (const adapter of adapters) {
      await expect(
        adapter.validateRecipient(PREMIUM, { username: '@HasPremium_Bob' }),
      ).resolves.toEqual({ status: 'REFUSED', reason: 'HAS_PREMIUM' });
      const ext = await adapter.validateRecipient(PREMIUM, { username: 'premiumext_bob' });
      expect(ext).toEqual({
        status: 'FOUND',
        providerRef: simulatedProviderRef('premiumext_bob'),
        displayName: 'premiumext_bob',
        notices: ['PREMIUM_EXTENDS'],
      });
      expect(RecipientCheckResultSchema.parse(ext)).toEqual(ext);
      await expect(adapter.validateRecipient(PREMIUM, { username: 'alice' })).resolves.toEqual({
        status: 'FOUND',
        providerRef: simulatedProviderRef('alice'),
        displayName: 'alice',
      });
    }
  });

  it('Stars or an unknown slug: the same names are a plain FOUND, no notice', async () => {
    for (const adapter of adapters) {
      for (const product of [STARS, { id: 'p', slug: 'ful-prod-x' }]) {
        for (const username of ['haspremium_bob', 'premiumext_bob']) {
          await expect(adapter.validateRecipient(product, { username })).resolves.toEqual({
            status: 'FOUND',
            providerRef: simulatedProviderRef(username),
            displayName: username,
          });
        }
      }
    }
  });

  it('the prefixes answer under scenario OK only; a premiumext_ order is paid normally', async () => {
    for (const scenario of SIM_SCENARIOS.filter((s) => s !== 'OK')) {
      const answer = await Promise.race([
        simulatedValidation(scenario, { username: 'haspremium_bob' }, undefined, 'PREMIUM'),
        Promise.resolve({ status: 'PENDING' } as const),
      ]);
      expect(answer.status).not.toBe('REFUSED');
    }
    const recipient = {
      fields: { username: 'premiumext_bob' },
      providerRef: simulatedProviderRef('premiumext_bob'),
    };
    expect(simulatedRecipientProblem('OK', recipient, 'PREMIUM')).toBeNull();
  });
});
