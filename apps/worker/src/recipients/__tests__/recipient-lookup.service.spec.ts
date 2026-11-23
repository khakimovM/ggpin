import type { RecipientCheckRequest } from '@repo/shared';
import type { FulfillmentAdapter } from '../../adapters/fulfillment-adapter';
import { SimulatedFragmentAdapter } from '../../adapters/simulator/simulated-fragment.adapter';
import { SimulatorScript } from '../../adapters/simulator/simulator-script';
import { AdapterRouter } from '../../fulfillment/adapter-router';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { DeadlineAbortError } from '../deadline';
import { RecipientLookupService } from '../recipient-lookup.service';
import type { RecipientProductRepository } from '../recipient-product.repository';
import { FOUND, PRODUCT_ID } from './processor-harness';
import { TG_USERNAME_FORM, stubAdapter } from './recipient-test-doubles';

// The lookup alone (S3b re-review m2; S7 gate I-1 and CR #2): the minCallMs edge after the route
// pick with a fake clock, the deadline's AbortSignal reaching the provider, and the issuer's
// namespace on a FOUND handle.

const BUDGET = 1_000;
const MIN_CALL = 50;
const REQUEST: RecipientCheckRequest = { productId: PRODUCT_ID, input: { username: 'aziz_k' } };

function setup(adapters: readonly FulfillmentAdapter[]) {
  const product = {
    id: PRODUCT_ID,
    slug: 'stars',
    isActive: true,
    allowCustomQty: true,
    inputSchema: TG_USERNAME_FORM,
    skus: [],
  };
  // No fresh cost snapshot: any currency (the snapshot rule: recipient-lookup-currency.spec.ts).
  const products = {
    find: jest.fn(() => Promise.resolve(product)),
    pricedBy: jest.fn(() => Promise.resolve(null)),
  } as unknown as RecipientProductRepository;
  const findMany = jest.fn(() => Promise.resolve([{ adapter: 'FRAGMENT' }]));
  const prisma = { client: { productRoute: { findMany } } } as unknown as PrismaService;
  const router = new AdapterRouter(prisma, new Map(adapters.map((a) => [a.code, a])));
  router['logger'].warn = jest.fn();
  return { lookup: new RecipientLookupService(products, router), findMany };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RecipientLookupService', () => {
  it('exactly minCallMs left after the route pick still asks the provider; 1 ms less does not', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const validate = jest.fn(() => Promise.resolve(FOUND));
    const { lookup, findMany } = setup([stubAdapter('FRAGMENT', { validate })]);
    findMany.mockImplementation(() => {
      now += BUDGET - MIN_CALL;
      return Promise.resolve([{ adapter: 'FRAGMENT' }]);
    });
    await expect(lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toMatchObject({
      reason: 'ANSWERED',
    });
    expect(validate).toHaveBeenCalledTimes(1);

    now = 2_000_000;
    findMany.mockImplementation(() => {
      now += BUDGET - MIN_CALL + 1;
      return Promise.resolve([{ adapter: 'FRAGMENT' }]);
    });
    await expect(lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toMatchObject({
      reason: 'TIMEOUT',
      adapter: 'FRAGMENT',
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('a hanging provider gets the deadline signal: aborted when the budget runs out', async () => {
    const signals: AbortSignal[] = [];
    const validate = jest.fn(
      (_p: unknown, _i: unknown, signal: AbortSignal) =>
        new Promise<never>(() => {
          signals.push(signal);
        }),
    );
    const { lookup } = setup([stubAdapter('FRAGMENT', { validate })]);
    await expect(lookup.check(REQUEST, 100, 10)).resolves.toMatchObject({ reason: 'TIMEOUT' });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBeInstanceOf(DeadlineAbortError);
  });

  it('a provider that answers UNAVAILABLE on the abort is still a TIMEOUT, not its answer', async () => {
    const validate = jest.fn(
      (_p: unknown, _i: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ status: 'UNAVAILABLE' }), {
            once: true,
          });
        }),
    );
    const { lookup } = setup([stubAdapter('FRAGMENT', { validate })]);
    await expect(lookup.check(REQUEST, 100, 10)).resolves.toMatchObject({
      reason: 'TIMEOUT',
      adapter: 'FRAGMENT',
    });
  });

  it('the signal is aborted when the lookup ends early too (nothing runs on)', async () => {
    const signals: AbortSignal[] = [];
    const validate = jest.fn((_p: unknown, _i: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return Promise.resolve(FOUND);
    });
    const { lookup } = setup([stubAdapter('FRAGMENT', { validate })]);
    await lookup.check(REQUEST, BUDGET, MIN_CALL);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('a FOUND handle is namespaced by its issuer; one that cannot be is BAD_ANSWER', async () => {
    const ok = setup([stubAdapter('FRAGMENT', { validate: () => Promise.resolve(FOUND) })]);
    await expect(ok.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toEqual({
      kind: 'RESULT',
      result: { ...FOUND, providerRef: 'FRAGMENT:ref-1' },
      reason: 'ANSWERED',
      adapter: 'FRAGMENT',
    });
    const long = { ...FOUND, providerRef: 'r'.repeat(256) };
    const bad = setup([stubAdapter('FRAGMENT', { validate: () => Promise.resolve(long) })]);
    await expect(bad.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toMatchObject({
      result: { status: 'UNAVAILABLE' },
      reason: 'BAD_ANSWER',
    });
  });

  it('the simulator honours the signal: a slow check answers UNAVAILABLE at once on abort', async () => {
    const fragment = new SimulatedFragmentAdapter(
      { NODE_ENV: 'test', FULFILLMENT_DRY_RUN: true },
      new SimulatorScript(),
    );
    const controller = new AbortController();
    const started = Date.now();
    const answer = fragment.validateRecipient(
      { id: PRODUCT_ID, slug: 'stars' },
      { username: 'slowcheck_abc' },
      controller.signal,
    );
    controller.abort();
    await expect(answer).resolves.toEqual({ status: 'UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(1_000);
    const late = fragment.validateRecipient(
      { id: PRODUCT_ID, slug: 'stars' },
      { username: 'aziz_k' },
      controller.signal,
    );
    await expect(late).resolves.toEqual({ status: 'UNAVAILABLE' });
  });

  it('phase 6: REFUSED passes through as it is; FOUND keeps its notices with the namespaced handle', async () => {
    const refused = { status: 'REFUSED', reason: 'HAS_PREMIUM' } as const;
    const a = setup([stubAdapter('FRAGMENT', { validate: () => Promise.resolve(refused) })]);
    await expect(a.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toEqual({
      kind: 'RESULT',
      result: refused,
      reason: 'ANSWERED',
      adapter: 'FRAGMENT',
    });
    const ext = { ...FOUND, notices: ['PREMIUM_EXTENDS'] };
    const b = setup([stubAdapter('FRAGMENT', { validate: () => Promise.resolve(ext) })]);
    const outcome = await b.lookup.check(REQUEST, BUDGET, MIN_CALL);
    expect(outcome.kind === 'RESULT' && outcome.result).toEqual({
      ...ext,
      providerRef: 'FRAGMENT:ref-1',
    });
    // A refusal that carries a handle or a name does not parse: UNAVAILABLE, never passed on.
    const leaky = { ...refused, displayName: 'Aziz' };
    const c = setup([stubAdapter('FRAGMENT', { validate: () => Promise.resolve(leaky) })]);
    await expect(c.lookup.check(REQUEST, BUDGET, MIN_CALL)).resolves.toMatchObject({
      result: { status: 'UNAVAILABLE' },
      reason: 'BAD_ANSWER',
    });
  });
});
