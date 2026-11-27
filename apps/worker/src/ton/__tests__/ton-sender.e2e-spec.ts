import { parseMajor } from '@repo/shared';
import type { Address } from '@ton/core';
import { buildTestEnv } from '../../config/__tests__/test-env';
import { FakeTonGateway } from '../fake-ton.gateway';
import type { TonAccountState } from '../ton-gateway';
import { heldNotices } from '../ton-notices';
import {
  eventsTo,
  operatorFailsAndRefunds,
  payRequest,
  rowsOf,
  transfersOf,
} from './ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  WALLET_BALANCE,
  pinChain,
  useTonE2e,
} from './ton-e2e.harness';

// The sending path of one payout on the real database (plan 6.4, docs/06 "5-faza S1", rules/45):
// the reference is committed before anything is broadcast, a replay never signs or sends again,
// a stalled worker sends nothing, and the limits hold the order before anything is signed.

const t = useTonE2e();
const TON = (major: string): bigint => parseMajor('TON', major);

/** The chain answers only after `stall` ran (an operator acting while the worker reads it). */
class StallingGateway extends FakeTonGateway {
  stall: (() => Promise<void>) | null = null;

  override async getAccountState(address: Address): Promise<TonAccountState> {
    const stall = this.stall;
    this.stall = null;
    if (stall !== null) await stall();
    return super.getAccountState(address);
  }
}

describe('TON payout: sending (plan 6.4, docs/06)', () => {
  it('commits the reference before the one broadcast, then CONFIRMED + attempt CONFIRMED + DELIVERED', async () => {
    const fixture = await t.order();
    const request = payRequest(fixture);
    const atBroadcast: unknown[] = [];
    t.ton.hooks.afterStoredFn = async () => {
      const rows = await rowsOf(t.db, fixture);
      atBroadcast.push({
        transfer: rows.transfer?.status,
        refIsHash: rows.attempt.externalRef === rows.transfer?.extMsgHash,
        sendBoc: t.gateway.callCount('sendBoc'),
      });
    };
    const result = await t.ton.sender.pay(request);
    expect(atBroadcast).toEqual([{ transfer: 'SIGNED', refIsHash: true, sendBoc: 0 }]);
    const { order, attempt, transfer } = await rowsOf(t.db, fixture);
    expect(result).toEqual({
      status: 'DELIVERED',
      transferId: transfer?.id,
      txHash: transfer?.txHash,
    });
    expect(transfer).toMatchObject({
      purpose: 'ORDER',
      network: 'testnet',
      walletAddress: t.wallet.rawAddress,
      toAddress: request.toAddress,
      amountNanoTon: request.amountNano,
      payloadHash: request.payload.hash().toString('hex'),
      status: 'CONFIRMED',
    });
    expect(transfer?.confirmedAt).toBeInstanceOf(Date);
    expect(transfer?.feeNanoTon).not.toBeNull();
    expect(attempt).toMatchObject({ status: 'CONFIRMED', externalRef: transfer?.extMsgHash });
    expect(attempt.response).toMatchObject({ ton: { txHash: transfer?.txHash } });
    expect(order.status).toBe('DELIVERED');
    expect(order.deliveredAt).toBeInstanceOf(Date);
    expect(await eventsTo(t.db, fixture.orderId, 'DELIVERED')).toBe(1);
    // The one broadcast carried exactly the stored message; the payee got exactly the amount.
    expect(t.gateway.sentBocs.map((boc) => boc.toString('base64'))).toEqual([transfer?.bocBase64]);
    expect(t.gateway.balanceOf(t.wallet.address)).toBeLessThan(WALLET_BALANCE - request.amountNano);
    await t.expectJobs([{ kind: 'ORDER_DELIVERED', orderId: fixture.orderId }]);
    await t.expectNoJob({ kind: 'ORDER_REVIEW', orderId: fixture.orderId });
  });

  it('a replayed job, here or in another worker, only follows its transfer: nothing signed or sent twice', async () => {
    const fixture = await t.order();
    const request = payRequest(fixture);
    const first = await t.ton.sender.pay(request);
    expect(first.status).toBe('DELIVERED');
    expect(await t.ton.sender.pay(request)).toEqual(first);
    const other = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    expect(await other.sender.pay(request)).toEqual(first);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    expect(await transfersOf(t.db, t.wallet.rawAddress)).toHaveLength(1);
    expect(await eventsTo(t.db, fixture.orderId, 'DELIVERED')).toBe(1);
  });

  it('docs/06: the operator failed and refunded the order, the stalled worker wakes: nothing sent or written', async () => {
    const fixture = await t.order();
    await operatorFailsAndRefunds(t.db, fixture);
    const result = await t.ton.sender.pay(payRequest(fixture));
    expect(result).toEqual({ status: 'STOPPED', reason: 'ORDER_NOT_PROCESSING' });
    expect(t.gateway.callCount('sendBoc')).toBe(0);
    expect(t.gateway.callCount('getAccountState')).toBe(0);
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer).toBeNull();
    expect(rows.attempt).toMatchObject({ status: 'FAILED', externalRef: null });
    expect(rows.order.status).toBe('REFUNDED');
    expect(await transfersOf(t.db, t.wallet.rawAddress)).toHaveLength(0);
  });

  it('docs/06: the operator acts while the worker reads the chain: the signing transaction refuses', async () => {
    const gateway = new StallingGateway({ production: false, dryRun: true });
    gateway.registerWallet(t.wallet, WALLET_BALANCE);
    const ton = await t.boot({ wallet: t.wallet, gateway });
    const fixture = await t.order();
    gateway.stall = () => operatorFailsAndRefunds(t.db, fixture);
    const result = await ton.sender.pay(payRequest(fixture));
    expect(result).toEqual({ status: 'STOPPED', reason: 'ORDER_NOT_PROCESSING' });
    expect(gateway.callCount('getAccountState')).toBe(1);
    expect(gateway.callCount('sendBoc')).toBe(0);
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer).toBeNull();
    expect(rows.attempt).toMatchObject({ status: 'FAILED', externalRef: null });
    expect(rows.order.status).toBe('REFUNDED');
  });

  it('a chain that cannot be read, a frozen wallet or a skewed clock sign nothing; the retry pays', async () => {
    const fixture = await t.order();
    const request = payRequest(fixture);
    t.gateway.failNext('getAccountState', 1, 'NETWORK');
    expect(await t.ton.sender.pay(request)).toEqual({ status: 'NOT_SENT', reason: 'GATEWAY' });
    pinChain(t.gateway, -400);
    expect(await t.ton.sender.pay(request)).toEqual({ status: 'NOT_SENT', reason: 'CLOCK_SKEW' });
    pinChain(t.gateway, 0);
    const untouched = await rowsOf(t.db, fixture);
    expect(untouched.transfer).toBeNull();
    expect(untouched.attempt).toMatchObject({ status: 'SENDING', externalRef: null });
    expect(untouched.order.status).toBe('PROCESSING');
    expect((await t.ton.sender.pay(request)).status).toBe('DELIVERED');
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    // A frozen hot wallet is never paid from (another order, the same wallet).
    t.gateway.freeze(t.wallet.address);
    const frozen = await t.order();
    expect(await t.ton.sender.pay(payRequest(frozen))).toEqual({
      status: 'NOT_SENT',
      reason: 'WALLET_NOT_READY',
    });
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('limits: exactly at the limit pays, one nanoton more holds before signing; EXPIRED is spent too', async () => {
    const env = buildTestEnv({
      DATABASE_URL: t.env.DATABASE_URL,
      REDIS_URL: t.env.REDIS_URL,
      TON_MAX_PER_ORDER_NANO: TON('2').toString(),
      TON_MAX_DAILY_NANO: TON('5').toString(),
    });
    const ton = await t.boot({ wallet: t.wallet, gateway: t.gateway, env });
    // 2 TON lost on the way and EXPIRED: still counted in the rolling 24 h sum (audit L5: the
    // verdict rests on one provider until the second source exists), so 2 + 2 + 1 = 5 = the limit.
    pinChain(t.gateway, SIGN_AT_SEC);
    t.gateway.nextSend('LOSE');
    ton.hooks.afterBroadcastFn = () => {
      pinChain(t.gateway, PAST_VALID_SEC);
      return Promise.resolve();
    };
    const lost = await t.order();
    expect((await ton.sender.pay(payRequest(lost, { amountNano: TON('2') }))).status).toBe(
      'EXPIRED',
    );
    ton.hooks.afterBroadcastFn = () => Promise.resolve();
    const atOrderMax = await t.order();
    const atDailyMax = await t.order();
    expect((await ton.sender.pay(payRequest(atOrderMax, { amountNano: TON('2') }))).status).toBe(
      'DELIVERED',
    );
    expect((await ton.sender.pay(payRequest(atDailyMax, { amountNano: TON('1') }))).status).toBe(
      'DELIVERED',
    );
    const overOrder = await t.order();
    const overDaily = await t.order();
    expect(await ton.sender.pay(payRequest(overOrder, { amountNano: TON('2') + 1n }))).toEqual({
      status: 'HELD',
      reason: 'LIMIT_PER_ORDER',
    });
    expect(await ton.sender.pay(payRequest(overDaily, { amountNano: 1n }))).toEqual({
      status: 'HELD',
      reason: 'LIMIT_DAILY',
    });
    expect(t.gateway.callCount('sendBoc')).toBe(3);
    for (const [fixture, reason] of [
      [overOrder, 'LIMIT_PER_ORDER'],
      [overDaily, 'LIMIT_DAILY'],
    ] as const) {
      const rows = await rowsOf(t.db, fixture);
      expect(rows.transfer).toBeNull();
      expect(rows.attempt).toMatchObject({ status: 'FAILED', error: reason, externalRef: null });
      expect(rows.order).toMatchObject({ status: 'HELD', statusReason: reason });
    }
    await t.expectJobs([
      ...heldNotices(overOrder.orderId, overOrder.attemptId, 'LIMIT_PER_ORDER'),
      ...heldNotices(overDaily.orderId, overDaily.attemptId, 'LIMIT_DAILY'),
    ]);
    await t.expectNoJob({
      kind: 'ALERT',
      alert: 'tonDailyLimit',
      refId: `${overOrder.orderId}_${overOrder.attemptId}`,
    });
  });

  it('a balance short of amount + fee reserve holds the order (LOW_BALANCE); exactly enough pays', async () => {
    const amount = TON('1');
    const reserve = t.env.TON_FEE_RESERVE_NANO;
    t.gateway.setBalance(t.wallet.address, amount + reserve - 1n);
    const short = await t.order();
    expect(await t.ton.sender.pay(payRequest(short, { amountNano: amount }))).toEqual({
      status: 'HELD',
      reason: 'LOW_BALANCE',
    });
    const rows = await rowsOf(t.db, short);
    expect(rows.transfer).toBeNull();
    expect(rows.attempt).toMatchObject({ status: 'FAILED', error: 'LOW_BALANCE' });
    expect(rows.order).toMatchObject({ status: 'HELD', statusReason: 'LOW_BALANCE' });
    expect(t.gateway.callCount('sendBoc')).toBe(0);
    await t.expectJobs(heldNotices(short.orderId, short.attemptId, 'LOW_BALANCE'));
    // The enqueue was lost (Redis away) and the job runs again: the hold is announced again.
    await t.dropJobs(heldNotices(short.orderId, short.attemptId, 'LOW_BALANCE'));
    expect(await t.ton.sender.pay(payRequest(short, { amountNano: amount }))).toEqual({
      status: 'STOPPED',
      reason: 'ORDER_NOT_PROCESSING',
    });
    await t.expectJobs(heldNotices(short.orderId, short.attemptId, 'LOW_BALANCE'));
    expect(t.gateway.callCount('getAccountState')).toBe(1);
    t.gateway.setBalance(t.wallet.address, amount + reserve);
    const enough = await t.order();
    expect((await t.ton.sender.pay(payRequest(enough, { amountNano: amount }))).status).toBe(
      'DELIVERED',
    );
  });
});
