import { SIMULATED_FRAGMENT_PAY_ADDRESS } from '../adapters/simulator/simulator-script';
import { parsePayAddresses } from './ton-env-live';
import type { WorkerTonEnv } from './ton-env';

/**
 * The simulated Fragment payee belongs to a non-production dry run only (CR m7, audit I-2): no key
 * exists for it, so a live payout to it is value lost for ever. In production (dry run or not) or
 * with FULFILLMENT_DRY_RUN=false the worker refuses to boot with it in FRAGMENT_PAY_ADDRESSES.
 */
export function simulatedPayeeProblems(
  env: Pick<WorkerTonEnv, 'FULFILLMENT_DRY_RUN' | 'TON_NETWORK' | 'FRAGMENT_PAY_ADDRESSES'>,
  production: boolean,
): string[] {
  if (env.FULFILLMENT_DRY_RUN && !production) return [];
  const payees = parsePayAddresses(env.FRAGMENT_PAY_ADDRESSES, env.TON_NETWORK).raw;
  if (!payees.includes(SIMULATED_FRAGMENT_PAY_ADDRESS)) return [];
  return [
    'FRAGMENT_PAY_ADDRESSES: the simulated Fragment payee is allowed only in a non-production dry run',
  ];
}
