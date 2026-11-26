import { randomBytes } from 'node:crypto';
import { Address } from '@ton/core';
import { SIMULATED_FRAGMENT_PAY_ADDRESS } from '../../adapters/simulator/simulator-script';
import { EnvValidationError, loadEnv } from '../env';
import { simulatedPayeeProblems } from '../simulated-payee';
import { TEST_ENV_SOURCE } from './test-env';
import { tonLiveSource } from './ton-live-env';

// The simulated Fragment payee is refused outside a non-production dry run (CR m7, audit I-2).

const REFUSED =
  'FRAGMENT_PAY_ADDRESSES: the simulated Fragment payee is allowed only in a non-production dry run';

function problemsOf(source: Record<string, string>): string {
  try {
    loadEnv(source);
    return '';
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
}

const real = new Address(0, randomBytes(32)).toRawString();

describe('worker env: the simulated Fragment payee', () => {
  it('a dry run (dev, test) may list it: dry-run payouts reach the in-memory chain', () => {
    expect(
      problemsOf({ ...TEST_ENV_SOURCE, FRAGMENT_PAY_ADDRESSES: SIMULATED_FRAGMENT_PAY_ADDRESS }),
    ).toBe('');
  });

  it('a live worker (FULFILLMENT_DRY_RUN=false) refuses to boot with it, in any spelling', () => {
    const live = { ...TEST_ENV_SOURCE, ...tonLiveSource(), FULFILLMENT_DRY_RUN: 'false' };
    expect(problemsOf({ ...live, FRAGMENT_PAY_ADDRESSES: real })).toBe('');
    const upper = SIMULATED_FRAGMENT_PAY_ADDRESS.toUpperCase();
    expect(problemsOf({ ...live, FRAGMENT_PAY_ADDRESSES: `${real}, ${upper}` })).toContain(REFUSED);
  });

  it('production refuses it even in a dry run', () => {
    const env = {
      FULFILLMENT_DRY_RUN: true,
      TON_NETWORK: 'testnet' as const,
      FRAGMENT_PAY_ADDRESSES: SIMULATED_FRAGMENT_PAY_ADDRESS,
    };
    expect(simulatedPayeeProblems(env, true)).toEqual([REFUSED]);
    expect(simulatedPayeeProblems(env, false)).toEqual([]);
    expect(simulatedPayeeProblems({ ...env, FRAGMENT_PAY_ADDRESSES: real }, true)).toEqual([]);
  });
});
