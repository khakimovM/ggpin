import { Logger } from '@nestjs/common';
import { parseMajor } from '@repo/shared';
import { Address, beginCell } from '@ton/core';
import type { TonWalletLock } from '../ton-lock';
import { heldNotices, walletBlockedNotice } from '../ton-notices';
import { TON_WALLET_LOCK } from '../ton-tokens';
import type { StoreRequest } from '../ton-transfer.repository';
import {
  E2E_PAY_ADDRESSES,
  payRequest,
  payee,
  rowsOf,
  stranger,
  transfersOf,
} from './ton-e2e.fixtures';
import {
  PAST_VALID_SEC,
  SIGN_AT_SEC,
  WALLET_BALANCE,
  pinChain,
  useTonE2e,
} from './ton-e2e.harness';

// The guards in front of a signature (audit L1, review m1, M4, m5, m6 (c, d)) on the real database
// and the in-memory chain: the payee allowlist, the attempt's own transfer before the lock, the
// blocked-wallet alert, the clocks, a deploying first payment and what the logs never carry.

const t = useTonE2e();
const TON = (major: string): bigint => parseMajor('TON', major);

describe('TON payout: guards before signing', () => {
  it.each([
    ['an address on no list', () => stranger(0)],
    ['a masterchain address', () => stranger(-1)],
  ])('%s: HELD before anything is read or signed (audit L1)', async (_name, address) => {
    const fixture = await t.order();
    const result = await t.ton.sender.pay(payRequest(fixture, { toAddress: address() }));
    expect(result).toEqual({ status: 'HELD', reason: 'ADAPTER_ERROR' });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer).toBeNull();
    expect(rows.attempt).toMatchObject({
      status: 'FAILED',
      error: 'PAY_ADDRESS_NOT_ALLOWED',
      externalRef: null,
    });
    expect(rows.order).toMatchObject({ status: 'HELD', statusReason: 'ADAPTER_ERROR' });
    expect(t.gateway.callCount('getAccountState')).toBe(0);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
    const notices = heldNotices(fixture.orderId, fixture.attemptId, 'ADAPTER_ERROR');
    await t.expectJobs(notices);
    // A replay of that job repeats the same notices (the enqueue may have been lost).
    await t.dropJobs(notices);
    expect(await t.ton.sender.pay(payRequest(fixture, { toAddress: address() }))).toEqual({
      status: 'STOPPED',
      reason: 'ORDER_NOT_PROCESSING',
    });
    await t.expectJobs(notices);
  });

  it('the signing transaction checks the payee and its own clock too (no signature either way)', async () => {
    const fixture = await t.order();
    let signed = 0;
    const base = (toAddress: string, chainTimeSec: number): StoreRequest => ({
      order: { ...fixture, allowedTo: E2E_PAY_ADDRESSES },
      network: 'testnet',
      walletAddress: t.wallet.rawAddress,
      toAddress,
      amountNano: TON('1'),
      seqno: 0,
      validUntilSec: chainTimeSec + 60,
      limits: { perOrderMaxNano: TON('50'), dailyMaxNano: TON('500') },
      chainTimeSec,
      maxSignLagSec: 90,
      sign: () => {
        signed += 1;
        throw new Error('must not sign');
      },
    });
    const now = Math.floor(Date.now() / 1_000);
    // The database clock 1000 s ahead of the chain time: nothing written, retry later (m5).
    expect(await t.ton.transfers.signAndStore(base(payee(), now - 1_000))).toEqual({
      kind: 'SKEWED',
    });
    expect((await rowsOf(t.db, fixture)).attempt).toMatchObject({ status: 'SENDING' });
    expect(await t.ton.transfers.signAndStore(base(stranger(), now))).toEqual({
      kind: 'HELD',
      reason: 'ADAPTER_ERROR',
    });
    expect(signed).toBe(0);
    expect((await rowsOf(t.db, fixture)).attempt).toMatchObject({
      status: 'FAILED',
      error: 'PAY_ADDRESS_NOT_ALLOWED',
    });
  });

  it('our clock 60 s off the database clock: nothing signed (m5)', async () => {
    const realNow = Date.now();
    t.gateway.setChainTime(Math.floor(realNow / 1_000) + 60);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
    const fixture = await t.order();
    try {
      expect(await t.ton.sender.pay(payRequest(fixture))).toEqual({
        status: 'NOT_SENT',
        reason: 'CLOCK_SKEW',
      });
    } finally {
      clock.mockRestore();
    }
    expect((await rowsOf(t.db, fixture)).transfer).toBeNull();
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('the lock held by a dead worker does not hide the attempt’s own transfer: it is followed (m1)', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    const fixture = await t.order();
    const request = payRequest(fixture);
    t.ton.hooks.afterStoredFn = () => Promise.reject(new Error('the worker died here'));
    await expect(t.ton.sender.pay(request)).rejects.toThrow('the worker died here');
    t.ton.hooks.afterStoredFn = () => Promise.resolve();
    // The dead worker's lease is still in Redis (its TTL has not run out).
    const lease = await t.ton.moduleRef.get<TonWalletLock>(TON_WALLET_LOCK).acquire();
    expect(lease).not.toBeNull();
    try {
      pinChain(t.gateway, PAST_VALID_SEC);
      const result = await t.ton.sender.pay(request);
      expect(result).toEqual({
        status: 'EXPIRED',
        transferId: (await rowsOf(t.db, fixture)).transfer?.id,
      });
    } finally {
      await lease?.release();
    }
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('an unresolved transfer older than the confirmation wait blocks the wallet: tonWalletBlocked (M4)', async () => {
    const fixture = await t.order();
    t.ton.hooks.afterStoredFn = () => Promise.reject(new Error('the worker died here'));
    await expect(t.ton.sender.pay(payRequest(fixture))).rejects.toThrow('the worker died here');
    const blocking = (await rowsOf(t.db, fixture)).transfer;
    expect(blocking?.status).toBe('SIGNED');
    const notice = walletBlockedNotice(blocking?.id ?? '');
    // Younger than the wait: busy, no alert yet.
    const next = await t.order();
    expect(await t.ton.sender.pay(payRequest(next))).toEqual({
      status: 'NOT_SENT',
      reason: 'WALLET_BUSY',
    });
    await t.expectNoJob(notice);
    // A worker whose wait is 1 ms sees it outlived: the owner hears it, once per transfer.
    const later = await t.boot({
      wallet: t.wallet,
      gateway: t.gateway,
      timing: { confirmTimeoutMs: 1 },
    });
    expect(await later.sender.pay(payRequest(next))).toEqual({
      status: 'NOT_SENT',
      reason: 'WALLET_BUSY',
    });
    await t.expectJobs([notice]);
    expect(await later.monitor.checkBlocked()).toBe(blocking?.id);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('the first payment of an undeployed wallet deploys it (seqno 0, StateInit) and is DELIVERED (m6 c)', async () => {
    const wallet = t.newWallet();
    t.gateway.registerWallet(wallet, WALLET_BALANCE, false);
    const ton = await t.boot({ wallet, gateway: t.gateway });
    const fixture = await t.order();
    expect((await ton.sender.pay(payRequest(fixture))).status).toBe('DELIVERED');
    const [row] = await transfersOf(t.db, wallet.rawAddress);
    expect(row).toMatchObject({ seqno: 0, status: 'CONFIRMED' });
    expect((await t.gateway.getAccountState(wallet.address)).status).toBe('active');
  });

  it('a whole payout logs no BOC, payload, key or API key (m6 d)', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
    try {
      const fixture = await t.order();
      const request = payRequest(fixture, {
        payload: beginCell().storeUint(0, 32).storeStringTail('payload-marker').endCell(),
      });
      t.gateway.destination(Address.parseRaw(request.toAddress), 'BOUNCE');
      expect((await t.ton.sender.pay(request)).status).toBe('REVIEW');
      const { transfer } = await rowsOf(t.db, fixture);
      const text = lines.join('\n');
      expect(lines.length).toBeGreaterThan(0);
      for (const secret of [
        transfer?.bocBase64 ?? 'none',
        Buffer.from(transfer?.bocBase64 ?? '', 'base64').toString('hex'),
        'payload-marker',
        t.wallet.own.publicKey.toString('hex'),
      ]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
