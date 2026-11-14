import { Address } from '@ton/core';
import { buildAdapterRegistry } from '../../../fulfillment/adapter-registry';
import { tonInstructionOf } from '../../../fulfillment/fulfill-steps';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { PrepareContext } from '../../fulfillment-adapter';
import { SimulatedFragmentAdapter, simulatedFragmentCost } from '../simulated-fragment.adapter';
import { SimulatedResellerAdapter } from '../simulated-reseller.adapter';
import { SimulatorRefusedError, assertSimulatorAllowed } from '../simulator-guard';
import {
  SIMULATED_FRAGMENT_PAY_ADDRESS,
  SimulatorScript,
  simulatedProviderRef,
} from '../simulator-script';

const DRY = { NODE_ENV: 'test', FULFILLMENT_DRY_RUN: true };

function context(orderId: string, providerRef: string | null = simulatedProviderRef('alice')) {
  return {
    orderId,
    attemptNo: 1,
    product: { id: 'p1', slug: 'stars' },
    sku: { id: null, quantity: 50 },
    recipient: { fields: { username: 'alice' }, providerRef },
  } satisfies PrepareContext;
}

describe('simulator guard (plan §8)', () => {
  it('refuses production and DRY_RUN=false, in the guard and in both constructors', () => {
    const script = new SimulatorScript();
    for (const env of [
      { NODE_ENV: 'production', FULFILLMENT_DRY_RUN: true },
      { NODE_ENV: 'development', FULFILLMENT_DRY_RUN: false },
    ]) {
      expect(() => assertSimulatorAllowed(env)).toThrow(SimulatorRefusedError);
      expect(() => new SimulatedFragmentAdapter(env, script)).toThrow(SimulatorRefusedError);
      expect(() => new SimulatedResellerAdapter(env, script)).toThrow(SimulatorRefusedError);
    }
    expect(() => assertSimulatorAllowed(DRY)).not.toThrow();
  });

  it('the registry has the simulators only in a non-production dry run', () => {
    const script = new SimulatorScript();
    const dry = buildAdapterRegistry(buildTestEnv(), script);
    expect([...dry.keys()].sort()).toEqual(['FRAGMENT', 'RESELLER_STARS']);
    const prodDry = { ...buildTestEnv(), NODE_ENV: 'production' as const };
    expect(buildAdapterRegistry(prodDry, script).size).toBe(0);
    const live = { ...buildTestEnv(), FULFILLMENT_DRY_RUN: false };
    expect(buildAdapterRegistry(live, script).size).toBe(0);
  });
});

describe('simulated Fragment', () => {
  const script = new SimulatorScript();
  const fragment = new SimulatedFragmentAdapter(DRY, script);

  it('prepares a TON instruction to the simulated payee for exactly the simulated price', async () => {
    const result = await fragment.prepare(context('o-ok'));
    if (result.status !== 'READY') throw new Error(`expected READY, got ${result.status}`);
    const cost = simulatedFragmentCost({ id: null, quantity: 50 });
    expect(result.prepared).toEqual(
      expect.objectContaining({ adapter: 'FRAGMENT', costCurrency: 'TON', costMinor: cost }),
    );
    expect(result.prepared.externalRef).toBeNull();
    expect(tonInstructionOf(result.prepared.request)).toEqual(
      expect.objectContaining({
        toAddress: SIMULATED_FRAGMENT_PAY_ADDRESS,
        amountNano: cost.toString(),
      }),
    );
    expect(Address.parseRaw(SIMULATED_FRAGMENT_PAY_ADDRESS).workChain).toBe(0);
  });

  it('scenarios: PRICE_UP doubles, NOT_FOUND gone, NOT_SENT refused, UNKNOWN/TIMEOUT throw', async () => {
    script.set('o-up', 'PRICE_UP');
    script.set('o-nf', 'NOT_FOUND');
    script.set('o-ns', 'NOT_SENT');
    script.set('o-un', 'UNKNOWN');
    script.set('o-to', 'TIMEOUT');
    const up = await fragment.prepare(context('o-up'));
    expect(up.status === 'READY' && up.prepared.costMinor).toBe(
      2n * simulatedFragmentCost({ id: null, quantity: 50 }),
    );
    expect(await fragment.prepare(context('o-nf'))).toEqual({ status: 'RECIPIENT_GONE' });
    expect(await fragment.prepare(context('o-ns'))).toEqual(
      expect.objectContaining({ status: 'REFUSED' }),
    );
    await expect(fragment.prepare(context('o-un'))).rejects.toThrow('simulated provider outage');
    await expect(fragment.prepare(context('o-to'))).rejects.toThrow('simulated provider outage');
  });

  it('a recipient that changed or has no handle is never prepared for payment', async () => {
    expect(await fragment.prepare(context('o-1', 'sim_bob'))).toEqual({
      status: 'RECIPIENT_CHANGED',
    });
    expect(await fragment.prepare(context('o-1', null))).toEqual({ status: 'RECIPIENT_GONE' });
    expect(await fragment.prepare(context('o-1', ' '))).toEqual({ status: 'RECIPIENT_GONE' });
  });

  it('send/confirm are not its way to pay: UNKNOWN (a misuse ends in review)', async () => {
    expect(await fragment.send()).toEqual(expect.objectContaining({ status: 'UNKNOWN' }));
    expect(await fragment.confirm()).toEqual(expect.objectContaining({ status: 'UNKNOWN' }));
  });
});

describe('simulated reseller', () => {
  const script = new SimulatorScript();
  const reseller = new SimulatedResellerAdapter(DRY, script);

  it('OK: a precomputed reference, SENT, then DELIVERED', async () => {
    const ctx = context('r-ok');
    const result = await reseller.prepare(ctx);
    if (result.status !== 'READY') throw new Error('expected READY');
    expect(result.prepared.externalRef).toBe('sim-r-ok');
    expect(await reseller.send(ctx, result.prepared)).toEqual(
      expect.objectContaining({ status: 'SENT', externalRef: 'sim-r-ok' }),
    );
    expect(await reseller.confirm(ctx)).toEqual(expect.objectContaining({ status: 'DELIVERED' }));
  });

  it('NOT_SENT carries a proof, UNKNOWN is unknown, TIMEOUT stays PENDING', async () => {
    script.set('r-ns', 'NOT_SENT');
    script.set('r-un', 'UNKNOWN');
    script.set('r-to', 'TIMEOUT');
    const prepared = await reseller.prepare(context('r-ns'));
    if (prepared.status !== 'READY') throw new Error('expected READY');
    const refused = await reseller.send(context('r-ns'), prepared.prepared);
    expect(refused.status === 'NOT_SENT' && refused.proof.kind).toBe('MANUAL');
    expect(await reseller.send(context('r-un'), prepared.prepared)).toEqual(
      expect.objectContaining({ status: 'UNKNOWN' }),
    );
    expect(await reseller.confirm(context('r-to'))).toEqual({ status: 'PENDING' });
  });
});
