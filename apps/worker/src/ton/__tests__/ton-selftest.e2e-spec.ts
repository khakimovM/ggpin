import { parseMajor } from '@repo/shared';
import type { TonGateway } from '../ton-gateway';
import type { TonWalletLock } from '../ton-lock';
import {
  runTonSelftest,
  SELFTEST_AMOUNT_NANO,
  SELFTEST_SUBWALLET,
  type SelftestDeps,
} from '../ton-selftest-flow';
import { TON_WALLET_LOCK, signLagMaxSec } from '../ton-tokens';
import { walletContractFor } from '../ton-wallet';
import { transfersOf } from './ton-e2e.fixtures';
import { PAST_VALID_SEC, SIGN_AT_SEC, TEST_TIMING, pinChain, useTonE2e } from './ton-e2e.harness';

// The whole `ton:selftest` flow (plan S5 CLI) on the fake chain and the scratch database: nobody
// runs it against testnet here. Step A must prove EXPIRED with a message broadcast after its
// valid_until; step B pays 0.01 TON to our own subwallet 1 and must end CONFIRMED with the seqno
// moved by exactly one. Both are SELFTEST rows under the same wallet lock and database fence.

const t = useTonE2e();
const TON = (major: string): bigint => parseMajor('TON', major);

function depsFor(lines: string[]): SelftestDeps {
  return {
    network: 'testnet',
    wallet: t.wallet,
    gateway: t.gateway,
    transfers: t.ton.transfers,
    // The fake chain does not move by itself: before each wait it is put past step A's validity
    // (on the real testnet the wall clock does this during the poll loop).
    confirm: {
      awaitOutcome: (transferId, keepAlive) => {
        pinChain(t.gateway, PAST_VALID_SEC);
        return t.ton.confirm.awaitOutcome(transferId, keepAlive);
      },
    },
    lock: t.ton.moduleRef.get<TonWalletLock>(TON_WALLET_LOCK),
    limits: { perOrderMaxNano: TON('50'), dailyMaxNano: TON('500') },
    feeReserveNano: t.env.TON_FEE_RESERVE_NANO,
    validSec: t.env.TON_SEND_VALID_SEC,
    // The wide test window: signing at SIGN_AT_SEC is 200 s behind the database clock.
    maxSignLagSec: signLagMaxSec(TEST_TIMING),
    say: (line) => lines.push(line),
    sleep: () => {
      t.gateway.advance(70);
      return Promise.resolve();
    },
  };
}

describe('ton:selftest on the fake chain', () => {
  it('A proves EXPIRED with a late message, B confirms 0.01 TON to subwallet 1; both SELFTEST rows', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    const lines: string[] = [];
    const report = await runTonSelftest(depsFor(lines));
    expect(report.steps.map((s) => [s.step, s.ok, s.status])).toEqual([
      ['EXPIRED_PROOF', true, 'EXPIRED'],
      ['TRANSFER', true, 'CONFIRMED'],
    ]);
    expect(report.ok).toBe(true);
    // Two broadcasts, in this order, each of its own stored message (the late one never landed).
    const rows = await transfersOf(t.db, t.wallet.rawAddress);
    expect(rows).toHaveLength(2);
    const sent = t.gateway.sentBocs.map((boc) =>
      rows.find((r) => r.bocBase64 === boc.toString('base64')),
    );
    expect(sent.map((r) => [r?.purpose, r?.attemptId, r?.status])).toEqual([
      ['SELFTEST', null, 'EXPIRED'],
      ['SELFTEST', null, 'CONFIRMED'],
    ]);
    const [late, paid] = sent;
    expect(paid?.seqno).toBe(late?.seqno);
    const subwallet = walletContractFor(t.wallet.own.publicKey, 'testnet', SELFTEST_SUBWALLET);
    expect(paid?.toAddress).toBe(subwallet.address.toRawString());
    expect(t.gateway.balanceOf(subwallet.address)).toBe(SELFTEST_AMOUNT_NANO);
    expect(lines.some((line) => line.startsWith('A PASS'))).toBe(true);
    expect(lines.some((line) => line.startsWith('B PASS'))).toBe(true);
  });

  it('another sender holding the wallet lock: the self-test signs nothing', async () => {
    const lock = t.ton.moduleRef.get<TonWalletLock>(TON_WALLET_LOCK);
    const lease = await lock.acquire();
    expect(lease).not.toBeNull();
    try {
      await expect(runTonSelftest(depsFor([]))).rejects.toThrow('another sender holds');
    } finally {
      await lease?.release();
    }
    expect(await transfersOf(t.db, t.wallet.rawAddress)).toHaveLength(0);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('step A not proven (a chain that took the late message): B never runs, the report fails', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    // The clock this gateway reports jumps past valid_until after the signing look, while the chain
    // itself is still inside it: the "late" message lands, as on a chain that ignored valid_until.
    let looks = 0;
    const gateway: TonGateway = {
      ...bindGateway(),
      getAccountState: async (address) => {
        const state = await t.gateway.getAccountState(address);
        looks += 1;
        return looks === 1 ? state : { ...state, chainTime: state.chainTime + 3_600 };
      },
    };
    const report = await runTonSelftest({
      ...depsFor([]),
      gateway,
      confirm: { awaitOutcome: (id, keepAlive) => t.ton.confirm.awaitOutcome(id, keepAlive) },
    });
    expect(report.ok).toBe(false);
    expect(report.steps.map((s) => [s.step, s.ok, s.status])).toEqual([
      ['EXPIRED_PROOF', false, 'CONFIRMED'],
    ]);
    expect((await transfersOf(t.db, t.wallet.rawAddress)).map((r) => r.status)).toEqual([
      'CONFIRMED',
    ]);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });
});

/** The fake gateway's methods bound to it (a spread of a class instance loses its prototype). */
function bindGateway(): TonGateway {
  const g = t.gateway;
  return {
    getAccountState: (address) => g.getAccountState(address),
    getBalance: (address) => g.getBalance(address),
    sendBoc: (boc) => g.sendBoc(boc),
    getTransactions: (address, page) => g.getTransactions(address, page),
    freshConnection: () => g.freshConnection(),
    findResultTx: (source, destination, createdLt) =>
      g.findResultTx(source, destination, createdLt),
  };
}
