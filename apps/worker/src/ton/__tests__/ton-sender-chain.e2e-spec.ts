import { Address, type Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import type { TonAccountState, TxPage } from '../ton-gateway';
import { TonHttpStatusError } from '../toncenter-http';
import { ToncenterGateway } from '../toncenter.gateway';
import { buildW5Data } from '../ton-w5';
import { payRequest, rowsOf } from './ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  WALLET_BALANCE,
  pinChain,
  useTonE2e,
} from './ton-e2e.harness';

// What the chain (or the provider in front of it) can do after our message left, on the real
// database: one stale answer (audit E4), a failing destination lookup (review M1, audit E6), inbound
// spam (audit H1) and a bounce of a message whose BROADCAST mark was never written (m6 b).

const t = useTonE2e();

/** A provider that answers ONE look with a state from before our transaction (current clock). */
class OneStaleAnswerGateway extends FakeTonGateway {
  staleAnswers = 0;
  private staleListing = false;

  override async getAccountState(address: Address): Promise<TonAccountState> {
    const real = await super.getAccountState(address);
    if (this.staleAnswers <= 0) return real;
    this.staleAnswers -= 1;
    this.staleListing = true;
    const own = t.wallet.own;
    return { ...real, data: buildW5Data(own, 0).toBoc(), lastTx: null };
  }

  override async getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    const real = await super.getTransactions(address, page);
    if (!this.staleListing) return real;
    this.staleListing = false;
    return [];
  }
}

/** The fake chain, but the destination lookup fails `lookupFailures` times through the REAL gateway. */
class FailingLookupGateway extends FakeTonGateway {
  lookupFailures = 0;
  lookups = 0;

  constructor(private readonly status: number) {
    super({ production: false, dryRun: true });
  }

  override findResultTx(source: Address, destination: Address, createdLt: bigint) {
    this.lookups += 1;
    if (this.lookupFailures <= 0) return super.findResultTx(source, destination, createdLt);
    this.lookupFailures -= 1;
    const body = JSON.stringify({ ok: false, error: 'rate limit', code: this.status });
    const real = new ToncenterGateway({
      endpoint: 'https://toncenter.invalid/api/v2/jsonRPC',
      dryRun: false,
      httpAdapter: () => Promise.reject(new TonHttpStatusError(this.status, body)),
    });
    return real.findResultTx(source, destination, createdLt);
  }
}

describe('TON payout: what the chain side can do', () => {
  it('ONE stale provider answer after the money left: no EXPIRED, no second payment (audit E4)', async () => {
    const gateway = new OneStaleAnswerGateway({ production: false, dryRun: true });
    gateway.registerWallet(t.wallet, WALLET_BALANCE);
    const ton = await t.boot({ wallet: t.wallet, gateway });
    const fixture = await t.order();
    const request = payRequest(fixture);
    pinChain(gateway, SIGN_AT_SEC);
    ton.hooks.afterBroadcastFn = () => {
      gateway.staleAnswers = 1;
      pinChain(gateway, PAST_VALID_SEC);
      return Promise.resolve();
    };
    const result = await ton.sender.pay(request);
    expect(result.status).toBe('DELIVERED');
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('CONFIRMED');
    expect(rows.order.status).toBe('DELIVERED');
    expect(gateway.balanceOf(Address.parseRaw(request.toAddress))).toBe(request.amountNano);
    expect(gateway.callCount('sendBoc')).toBe(1);
    // The replay only follows: nothing is signed or sent again.
    expect(await ton.sender.pay(request)).toEqual(result);
    expect(gateway.callCount('sendBoc')).toBe(1);
  });

  it.each([429, 503])(
    'the destination bounced, its lookup answered HTTP %i first: REVIEW BOUNCED, never DELIVERED (E6)',
    async (status) => {
      const gateway = new FailingLookupGateway(status);
      gateway.registerWallet(t.wallet, WALLET_BALANCE);
      const ton = await t.boot({ wallet: t.wallet, gateway });
      const fixture = await t.order();
      const request = payRequest(fixture);
      gateway.destination(Address.parseRaw(request.toAddress), 'BOUNCE');
      gateway.lookupFailures = 3;
      // Past the destination's grace at once: an error must not count as "not found".
      ton.hooks.afterBroadcastFn = () => {
        gateway.advance(30);
        return Promise.resolve();
      };
      const result = await ton.sender.pay(request);
      expect(result).toMatchObject({
        status: 'REVIEW',
        orderStatus: 'NEEDS_REVIEW',
        transferStatus: 'BOUNCED',
      });
      expect(gateway.lookups).toBeGreaterThan(3);
      expect(gateway.balanceOf(Address.parseRaw(request.toAddress))).toBe(0n);
    },
  );

  it('a lookup that keeps failing ends in CONFIRM_TIMEOUT review, never DELIVERED', async () => {
    const gateway = new FailingLookupGateway(429);
    gateway.registerWallet(t.wallet, WALLET_BALANCE);
    const ton = await t.boot({
      wallet: t.wallet,
      gateway,
      timing: { confirmTimeoutMs: 1_500 },
    });
    const fixture = await t.order();
    const request = payRequest(fixture);
    gateway.destination(Address.parseRaw(request.toAddress), 'BOUNCE');
    gateway.lookupFailures = Number.MAX_SAFE_INTEGER;
    ton.hooks.afterBroadcastFn = () => {
      gateway.advance(30);
      return Promise.resolve();
    };
    const result = await ton.sender.pay(request);
    expect(result).toMatchObject({
      status: 'REVIEW',
      orderStatus: 'NEEDS_REVIEW',
      transferStatus: 'BROADCAST',
    });
    expect((await rowsOf(t.db, fixture)).order).toMatchObject({
      status: 'NEEDS_REVIEW',
      statusReason: 'CONFIRM_TIMEOUT',
    });
  });

  it.each([128, 600])(
    '%i inbound spam transfers right after our payout: still found, DELIVERED (audit H1)',
    async (count) => {
      const fixture = await t.order();
      t.ton.hooks.afterBroadcastFn = () => {
        t.gateway.receiveSpam(t.wallet.address, count);
        return Promise.resolve();
      };
      expect((await t.ton.sender.pay(payRequest(fixture))).status).toBe('DELIVERED');
      expect((await rowsOf(t.db, fixture)).order.status).toBe('DELIVERED');
    },
  );

  it('the network took it, the call failed (no BROADCAST mark), the destination bounced: SIGNED -> BOUNCED (m6 b)', async () => {
    const fixture = await t.order();
    const request = payRequest(fixture);
    t.gateway.destination(Address.parseRaw(request.toAddress), 'BOUNCE');
    t.gateway.nextSend('LAND_THEN_THROW');
    const seen: unknown[] = [];
    t.ton.hooks.afterBroadcastFn = async () => {
      seen.push((await rowsOf(t.db, fixture)).transfer?.status);
    };
    const result = await t.ton.sender.pay(request);
    expect(seen).toEqual(['SIGNED']);
    expect(result).toMatchObject({ status: 'REVIEW', transferStatus: 'BOUNCED' });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('BOUNCED');
    expect(rows.order).toMatchObject({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' });
    await t.expectJobs([{ kind: 'ALERT', alert: 'tonBounced', refId: rows.transfer?.id ?? '' }]);
  });
});
