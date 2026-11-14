import { parseMajor } from '@repo/shared';
import { Address, type Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import type { TonAccountState, TonChainWitness, TxPage } from '../ton-gateway';
import type { TonPayResult } from '../ton-payout';
import { buildW5Data } from '../ton-w5';
import { payRequest, rowsOf, tonFactOf } from './ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  WALLET_BALANCE,
  pinChain,
  useTonE2e,
} from './ton-e2e.harness';

// D-60 (2) on the real database: a provider that keeps answering with the wallet as it was BEFORE
// our transaction (seqno 0, no transactions), with a current chain time, for a while after the
// money left. Audit M-1 E4c: longer than the expiry gap, on the kept-alive connection only (a
// fresh connection reaches an up-to-date node: freshIsStale=false) -> no EXPIRED, no second
// payment. A provider stale on the fresh connection too, for longer than the gap, still proves a
// false EXPIRED: only an independent witness closes that (review RR2 #2, the S12 gate in docs/06).
// Review MJ1: the whole provider stale, but for less than the gap (several stale answers inside
// it) -> the first observation is kept, the later ones confirm nothing, no EXPIRED.

const t = useTonE2e();
const ONE_TON = parseMajor('TON', '1');

class StickyStaleGateway extends FakeTonGateway {
  /** Epoch ms until which the kept-alive connection answers from the past. */
  until = 0;
  staleReads = 0;
  freshConnections = 0;
  /** The fresh connection is as stale as the kept-alive one (the whole provider lags). */
  freshIsStale = false;
  ownData: Buffer | null = null;

  override async getAccountState(address: Address): Promise<TonAccountState> {
    const real = await super.getAccountState(address);
    if (!this.stale() || this.ownData === null) return real;
    this.staleReads += 1;
    return { ...real, data: this.ownData, lastTx: null };
  }

  override async getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    const real = await super.getTransactions(address, page);
    return this.stale() ? [] : real;
  }

  override freshConnection(): TonChainWitness {
    this.freshConnections += 1;
    if (this.freshIsStale) return super.freshConnection();
    return {
      getAccountState: (address) => super.getAccountState(address),
      getTransactions: (address, page) => super.getTransactions(address, page),
    };
  }

  private stale(): boolean {
    return Date.now() < this.until;
  }
}

interface Run {
  readonly first: TonPayResult;
  readonly second: TonPayResult | null;
  readonly gateway: StickyStaleGateway;
  readonly paidNano: bigint;
  readonly expiry: unknown;
}

/** One payout; right after its broadcast the provider turns stale for `staleMs`. */
async function payThroughStaleness(staleMs: number, gapSec: number, freshIsStale: boolean) {
  const wallet = t.newWallet();
  const gateway = new StickyStaleGateway({ production: false, dryRun: true });
  gateway.registerWallet(wallet, WALLET_BALANCE);
  gateway.ownData = buildW5Data(wallet.own, 0).toBoc();
  gateway.freshIsStale = freshIsStale;
  const ton = await t.boot({
    wallet,
    gateway,
    timing: { expiryGapSec: gapSec, confirmTimeoutMs: 30_000 },
  });
  const fixture = await t.order();
  const request = payRequest(fixture);
  pinChain(gateway, SIGN_AT_SEC);
  ton.hooks.afterBroadcastFn = () => {
    gateway.until = Date.now() + staleMs;
    pinChain(gateway, PAST_VALID_SEC);
    return Promise.resolve();
  };
  const first = await ton.sender.pay(request);
  ton.hooks.afterBroadcastFn = () => Promise.resolve();
  gateway.until = 0;
  // What the fulfillment core would do after EXPIRED: the next attempt pays again.
  const second =
    first.status === 'EXPIRED'
      ? await ton.sender.pay(
          payRequest(await t.attempt(fixture, 2), { toAddress: request.toAddress }),
        )
      : null;
  const rows = await rowsOf(t.db, fixture);
  const run: Run = {
    first,
    second,
    gateway,
    paidNano: gateway.balanceOf(Address.parseRaw(request.toAddress)),
    expiry: tonFactOf(rows.attempt.response, 'expiry'),
  };
  return run;
}

describe('TON payout: stale provider answers vs EXPIRED (D-60 (2))', () => {
  it('M-1 E4c: stale on the kept-alive connection for 8 s > gap 5 s: no EXPIRED, paid once', async () => {
    const run = await payThroughStaleness(8_000, 5, false);
    expect(run.gateway.staleReads).toBeGreaterThan(2);
    expect({ sendBoc: run.gateway.callCount('sendBoc'), paidNano: run.paidNano }).toEqual({
      sendBoc: 1,
      paidNano: ONE_TON,
    });
    expect(run.first.status).toBe('DELIVERED');
    expect(run.second).toBeNull();
    expect(run.gateway.freshConnections).toBeGreaterThan(0);
  }, 30_000);

  it('MJ1: the whole provider stale for 2.5 s, gap 6 s > poll: first kept, no EXPIRED, paid once', async () => {
    const run = await payThroughStaleness(2_500, 6, true);
    // At least two stale answers inside the gap.
    expect(run.gateway.staleReads).toBeGreaterThanOrEqual(2);
    expect(run.first.status).toBe('DELIVERED');
    expect(run.gateway.callCount('sendBoc')).toBe(1);
    expect(run.paidNano).toBe(ONE_TON);
    // The stale answers were observations: the first is kept (it stays on the CONFIRMED attempt).
    expect(run.expiry).toMatchObject({ first: { seqno: 0 } });
    expect(run.expiry).not.toHaveProperty('second');
  }, 30_000);
});
