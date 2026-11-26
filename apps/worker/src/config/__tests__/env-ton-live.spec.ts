import { randomBytes } from 'node:crypto';
import { Address } from '@ton/core';
import { EnvValidationError, loadEnv } from '../env';
import { endpointProblems, parsePayAddresses } from '../ton-env-live';
import { TEST_ENV_SOURCE } from './test-env';
import { tonLiveSource } from './ton-live-env';

// What a worker that can really pay must be given (audit L1, L4, L5, review M2, D-60 (2)). Messages
// name the variable and the rule, never a value.

function problemsOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
    return '';
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
}

function liveSource(patch: Record<string, string> = {}): Record<string, string> {
  return { ...TEST_ENV_SOURCE, ...tonLiveSource(), FULFILLMENT_DRY_RUN: 'false', ...patch };
}

const account = (workchain: 0 | -1 = 0) => new Address(workchain, randomBytes(32));

describe('worker env: a live TON worker (FULFILLMENT_DRY_RUN=false)', () => {
  it('the per-run fake live source boots on testnet', () => {
    expect(problemsOf(liveSource())).toBe('');
  });

  it('the limits must be given explicitly: their defaults are for dry runs only (L5)', () => {
    const { TON_MAX_PER_ORDER_NANO: _a, TON_MAX_DAILY_NANO: _b, ...without } = liveSource();
    const message = problemsOf(without);
    expect(message).toContain(
      'TON_MAX_PER_ORDER_NANO: must be set explicitly with FULFILLMENT_DRY_RUN=false',
    );
    expect(message).toContain('TON_MAX_DAILY_NANO: must be set explicitly');
    // A dry run keeps its defaults.
    expect(problemsOf({ ...TEST_ENV_SOURCE })).toBe('');
  });

  it('TON_API_KEY is required (no keyless rate limit, review M2)', () => {
    const { TON_API_KEY: _key, ...without } = liveSource();
    expect(problemsOf(without)).toContain(
      'TON_API_KEY: is required with FULFILLMENT_DRY_RUN=false',
    );
  });

  it('https always, not only in production (L4)', () => {
    const message = problemsOf(liveSource({ TON_API_ENDPOINT: 'http://toncenter.invalid/api' }));
    expect(message).toContain(
      'TON_API_ENDPOINT: must use https whenever FULFILLMENT_DRY_RUN=false',
    );
  });

  it('the endpoint must serve TON_NETWORK (L4)', () => {
    expect(endpointProblems('https://toncenter.com/api/v2/jsonRPC', 'testnet')).toEqual([
      'TON_API_ENDPOINT: serves mainnet, not TON_NETWORK=testnet',
    ]);
    expect(endpointProblems('https://testnet.toncenter.com/api/v2/jsonRPC', 'mainnet')).toEqual([
      'TON_API_ENDPOINT: serves testnet, not TON_NETWORK=mainnet',
    ]);
    expect(endpointProblems('https://TOONCENTER.invalid/x', 'mainnet')).toEqual([
      'TON_API_ENDPOINT: not a known mainnet endpoint (toncenter.com)',
    ]);
    expect(endpointProblems('https://testnet.toncenter.com/api/v2/jsonRPC', 'testnet')).toEqual([]);
    expect(endpointProblems('https://toncenter.com/api/v2/jsonRPC', 'mainnet')).toEqual([]);
    expect(endpointProblems('not a url', 'testnet')).toEqual(['TON_API_ENDPOINT: is not a URL']);
  });

  it('a trailing dot names the same host (audit I-2): toncenter.com. is mainnet', () => {
    expect(endpointProblems('https://toncenter.com./api/v2/jsonRPC', 'testnet')).toEqual([
      'TON_API_ENDPOINT: serves mainnet, not TON_NETWORK=testnet',
    ]);
    expect(endpointProblems('https://TONCENTER.COM./api/v2/jsonRPC', 'testnet')).toEqual([
      'TON_API_ENDPOINT: serves mainnet, not TON_NETWORK=testnet',
    ]);
    expect(endpointProblems('https://testnet.toncenter.com./api/v2/jsonRPC', 'mainnet')).toEqual([
      'TON_API_ENDPOINT: serves testnet, not TON_NETWORK=mainnet',
    ]);
    expect(endpointProblems('https://toncenter.com./api/v2/jsonRPC', 'mainnet')).toEqual([]);
    expect(
      problemsOf(liveSource({ TON_API_ENDPOINT: 'https://toncenter.com./api/v2/jsonRPC' })),
    ).toContain('TON_API_ENDPOINT: serves mainnet, not TON_NETWORK=testnet');
  });

  it('mainnet is refused until a second chain source for the EXPIRED proof exists (D-60 (2))', () => {
    const message = problemsOf(
      liveSource({
        TON_NETWORK: 'mainnet',
        TON_API_ENDPOINT: 'https://toncenter.com/api/v2/jsonRPC',
        FRAGMENT_PAY_ADDRESSES: account().toRawString(),
      }),
    );
    expect(message).toContain('TON_NETWORK=mainnet: a second, independent chain source');
  });

  it('on mainnet: FRAGMENT_PAY_ADDRESSES is required and a test-only wallet address is refused', () => {
    const wallet = account().toString({ testOnly: true });
    const message = problemsOf(
      liveSource({
        TON_NETWORK: 'mainnet',
        TON_API_ENDPOINT: 'https://toncenter.com/api/v2/jsonRPC',
        TON_WALLET_ADDRESS: wallet,
      }),
    );
    expect(message).toContain(
      'FRAGMENT_PAY_ADDRESSES: at least one address is required on mainnet',
    );
    expect(message).toContain('TON_WALLET_ADDRESS: is a test-only address on mainnet');
    expect(message).not.toContain(wallet);
  });
});

describe('FRAGMENT_PAY_ADDRESSES (audit L1, Q7)', () => {
  it('raw and user-friendly forms, trimmed, deduplicated, in the stored raw spelling', () => {
    const one = account();
    const two = account();
    const text = ` ${one.toString()} ,${two.toRawString().toUpperCase()}, ${one.toRawString()},`;
    expect(parsePayAddresses(text, 'testnet')).toEqual({
      raw: [one.toRawString(), two.toRawString()],
      problems: [],
    });
    expect(parsePayAddresses(undefined, 'testnet')).toEqual({ raw: [], problems: [] });
  });

  it('a masterchain address, garbage or a test-only address on mainnet are refused by index', () => {
    const master = account(-1).toRawString();
    const testOnly = account().toString({ testOnly: true });
    const parsed = parsePayAddresses(`${account().toRawString()},${master},garbage`, 'testnet');
    expect(parsed.raw).toHaveLength(1);
    expect(parsed.problems).toEqual([
      'FRAGMENT_PAY_ADDRESSES: entry 2 is not a TON address of workchain 0',
      'FRAGMENT_PAY_ADDRESSES: entry 3 is not a TON address of workchain 0 or -1',
    ]);
    expect(parsePayAddresses(testOnly, 'mainnet').problems).toEqual([
      'FRAGMENT_PAY_ADDRESSES: entry 1 is a test-only address on mainnet',
    ]);
    // A dry run checks the list too: a typo is found before going live.
    const message = problemsOf({ ...TEST_ENV_SOURCE, FRAGMENT_PAY_ADDRESSES: `x,${master}` });
    expect(message).toContain('FRAGMENT_PAY_ADDRESSES: entry 1');
    expect(message).toContain('FRAGMENT_PAY_ADDRESSES: entry 2');
    expect(message).not.toContain(master);
  });
});
