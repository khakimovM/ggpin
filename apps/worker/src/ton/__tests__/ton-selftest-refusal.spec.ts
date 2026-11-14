import { DisabledTonGateway } from '../disabled-ton.gateway';
import type { TonLease } from '../ton-lock';
import {
  runTonSelftest,
  SELFTEST_AMOUNT_NANO,
  SelftestRefusedError,
  selftestRefusal,
  type SelftestDeps,
} from '../ton-selftest-flow';
import { dryRunTonWallet } from '../ton-wallet';

// The self-test is a testnet tool (plan S5, §11 "testnet/mainnet aralashuvi"); its whole run on
// the fake chain and the database is in ton-selftest.e2e-spec.ts. Nobody runs it for real here.

const mustNotRun = () => Promise.reject(new Error('must not be used'));

function depsFor(network: 'mainnet' | 'testnet', acquire: () => Promise<TonLease | null>) {
  const deps: SelftestDeps = {
    network,
    wallet: dryRunTonWallet(network),
    gateway: new DisabledTonGateway(),
    transfers: { signAndStore: mustNotRun, markBroadcast: mustNotRun },
    confirm: { awaitOutcome: mustNotRun },
    lock: { acquire },
    limits: { perOrderMaxNano: 1n, dailyMaxNano: 1n },
    feeReserveNano: 0n,
    validSec: 60,
    maxSignLagSec: 90,
    say: () => undefined,
    sleep: () => Promise.resolve(),
  };
  return deps;
}

describe('ton:selftest refusals', () => {
  it('only testnet, only a live run, never production', () => {
    const ok = {
      NODE_ENV: 'development',
      TON_NETWORK: 'testnet',
      FULFILLMENT_DRY_RUN: false,
    } as const;
    expect(selftestRefusal(ok)).toBeNull();
    expect(selftestRefusal({ ...ok, TON_NETWORK: 'mainnet' })).toContain('mainnet is refused');
    expect(selftestRefusal({ ...ok, FULFILLMENT_DRY_RUN: true })).toContain('FULFILLMENT_DRY_RUN');
    expect(selftestRefusal({ ...ok, NODE_ENV: 'production' })).toContain('production');
    expect(SELFTEST_AMOUNT_NANO).toBe(10_000_000n);
  });

  it('the flow refuses mainnet before touching the lock, the chain or the database', async () => {
    const acquire = jest.fn<Promise<TonLease | null>, []>().mockResolvedValue(null);
    await expect(runTonSelftest(depsFor('mainnet', acquire))).rejects.toBeInstanceOf(
      SelftestRefusedError,
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it('another sender holding the wallet lock stops it before anything is signed', async () => {
    await expect(runTonSelftest(depsFor('testnet', () => Promise.resolve(null)))).rejects.toThrow(
      'another sender holds the TON wallet lock',
    );
  });
});
