import { randomBytes } from 'node:crypto';
import { Address, beginCell, type Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import { rawAddress } from '../ton-address';
import { TonChainReader } from '../ton-chain-reader';
import type { TonVerdict } from '../ton-classifier';
import type { TonAccountState, TxPage } from '../ton-gateway';
import type { TonTiming } from '../ton-tokens';
import type { StoredTransfer } from '../ton-transfer.repository';
import {
  NO_PROGRESS,
  SCAN_PAGE_SIZE,
  advanceScan,
  type ScanAnchor,
  type ScanProgress,
  type ScanRequest,
  type ScanStep,
} from '../ton-tx-scan';
import { dryRunTonWallet, type TonWallet } from '../ton-wallet';

// Scan progress survives bad answers (review m1, audit L-2): a failing listing ends the look
// PARTIAL with the cursor kept, a STALE answer keeps what was covered, and the page is toncenter's
// documented maximum (ton-http-api getTransactions: limit gt=0, le=100).

const TON = 1_000_000_000n;
const T0 = 1_800_000_000;
const NOT_OURS = 'ff'.repeat(32);

/** The index of the kept-alive node answers one listing with nothing (a lagging backend). */
class FlakyIndexGateway extends FakeTonGateway {
  emptyNext = 0;

  override async getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    const real = await super.getTransactions(address, page);
    if (this.emptyNext === 0 || page.at === undefined) return real;
    this.emptyNext -= 1;
    return [];
  }
}

function setup(spam: number) {
  const gateway = new FlakyIndexGateway({ production: false, dryRun: true });
  const wallet = dryRunTonWallet('testnet');
  gateway.registerWallet(wallet, 10n * TON);
  gateway.setChainTime(T0);
  gateway.receiveSpam(wallet.address, spam);
  const pages: TxPage[] = [];
  const request = (pagesPerLook?: number): ScanRequest => ({
    fetchPage: (page) => {
      pages.push(page);
      return gateway.getTransactions(wallet.address, page);
    },
    address: wallet.address,
    extMsgHash: NOT_OURS,
    sinceUtime: T0 - 100,
    ...(pagesPerLook === undefined ? {} : { pagesPerLook }),
  });
  return { gateway, wallet, pages, request };
}

const anchorAt = (state: TonAccountState) => (): Promise<ScanAnchor> =>
  Promise.resolve({ state, atMs: null });
function progressOf(step: ScanStep): ScanProgress {
  if (step.kind === 'FOUND') throw new Error('unexpected FOUND');
  return step.progress;
}
const noNewPass = (): Promise<ScanAnchor> => Promise.reject(new Error('a new pass was started'));

describe('advanceScan: progress survives bad answers', () => {
  it('pages are toncenter`s documented maximum of 100 transactions', async () => {
    const { gateway, wallet, pages, request } = setup(250);
    const state = await gateway.getAccountState(wallet.address);
    expect(SCAN_PAGE_SIZE).toBe(100);
    expect((await advanceScan(request(), NO_PROGRESS, anchorAt(state))).kind).toBe('COMPLETE');
    expect(pages.map((p) => p.limit)).toEqual([100, 100, 100]);
  });

  it('a STALE answer keeps covered: an old state, then an index newer than the state', async () => {
    const { gateway, wallet, pages, request } = setup(30);
    const old = await gateway.getAccountState(wallet.address);
    gateway.receiveSpam(wallet.address, 30);
    const current = await gateway.getAccountState(wallet.address);
    const done = await advanceScan(request(), NO_PROGRESS, anchorAt(current));
    expect(done.kind).toBe('COMPLETE');
    const covered = progressOf(done).covered;
    expect(covered).toEqual(current.lastTx);
    // A state older than what was covered.
    const behind = await advanceScan(request(), progressOf(done), anchorAt(old));
    expect(behind).toEqual({ kind: 'STALE', progress: { covered, pass: null } });
    // M-1 (a): the index lists a transaction the state does not know yet.
    gateway.receiveSpam(wallet.address, 1);
    const ahead = await advanceScan(request(), progressOf(done), anchorAt(current));
    expect(ahead).toEqual({ kind: 'STALE', progress: { covered, pass: null } });
    // The next pass reads only what is new, down to the covered transaction: one listing.
    const fresh = await gateway.getAccountState(wallet.address);
    pages.length = 0;
    const next = await advanceScan(request(), progressOf(ahead), anchorAt(fresh));
    expect(next).toMatchObject({ kind: 'COMPLETE', progress: { covered: fresh.lastTx } });
    expect(pages).toHaveLength(1);
  });

  it('a failing listing ends the look PARTIAL with the cursor kept; an empty page too', async () => {
    const { gateway, wallet, pages, request } = setup(250);
    const state = await gateway.getAccountState(wallet.address);
    const first = await advanceScan(request(1), NO_PROGRESS, anchorAt(state));
    expect(first).toMatchObject({ kind: 'PARTIAL', cause: 'BUDGET' });
    gateway.failNext('getTransactions', 1, 'HTTP');
    const failed = await advanceScan(request(1), progressOf(first), noNewPass);
    expect(failed).toEqual({ kind: 'PARTIAL', cause: 'GATEWAY', progress: progressOf(first) });
    gateway.emptyNext = 1;
    const empty = await advanceScan(request(1), progressOf(failed), noNewPass);
    expect(empty).toEqual({ kind: 'STALE', progress: progressOf(first) });
    const second = await advanceScan(request(1), progressOf(empty), noNewPass);
    expect(second).toMatchObject({ kind: 'PARTIAL', cause: 'BUDGET' });
    expect((await advanceScan(request(1), progressOf(second), noNewPass)).kind).toBe('COMPLETE');
    // 251 transactions in three pages, plus the failed and the empty listing: nothing read twice.
    expect(pages).toHaveLength(5);
  });

  it('a failing head listing of a new pass keeps covered', async () => {
    const { gateway, wallet, request } = setup(5);
    const state = await gateway.getAccountState(wallet.address);
    const done = await advanceScan(request(), NO_PROGRESS, anchorAt(state));
    gateway.failNext('getTransactions', 1, 'HTTP');
    expect(await advanceScan(request(), progressOf(done), anchorAt(state))).toEqual({
      kind: 'PARTIAL',
      cause: 'GATEWAY',
      progress: progressOf(done),
    });
  });
});

describe('TonChainReader: spam + a 429 + a STALE answer still end FOUND (review m1)', () => {
  const TIMING: TonTiming = {
    pollMs: 10,
    destGraceSec: 20,
    confirmTimeoutMs: 300_000,
    lockTtlMs: 120_000,
    maxClockSkewSec: 60,
    expiryGapSec: 30,
  };

  function paid(gateway: FakeTonGateway, wallet: TonWallet): Promise<StoredTransfer> {
    const payee = new Address(0, randomBytes(32));
    const body = beginCell().storeUint(0, 32).storeStringTail('order').endCell();
    const signed = wallet.sign({
      seqno: 0,
      validUntilSec: T0 + 60,
      to: payee,
      amountNano: TON,
      body,
      bounce: true,
      deploy: false,
    });
    return gateway.sendBoc(signed.boc).then(() => ({
      id: 'cm0scan1',
      purpose: 'ORDER',
      attemptId: 'a1',
      network: 'testnet',
      walletAddress: wallet.rawAddress,
      seqno: 0,
      validUntil: new Date((T0 + 60) * 1_000),
      toAddress: rawAddress(payee),
      amountNanoTon: TON,
      payloadHash: signed.payloadHash,
      extMsgHash: signed.extMsgHash,
      status: 'BROADCAST',
      txHash: null,
      createdAt: new Date(T0 * 1_000),
    }));
  }

  it('1500 spam after ours: SCANNING, GATEWAY, INDEX_STALE, then CONFIRMED, nothing re-read', async () => {
    const { gateway, wallet } = setup(0);
    const transfer = await paid(gateway, wallet);
    gateway.receiveSpam(wallet.address, 1_500);
    const reader = new TonChainReader(gateway, wallet, TIMING, []);
    const look = (): Promise<TonVerdict> =>
      reader.examine(transfer, () => Promise.resolve(T0 * 1_000));
    const seen: TonVerdict[] = [await look()];
    gateway.failNext('getTransactions', 1, 'HTTP');
    seen.push(await look());
    gateway.emptyNext = 1;
    seen.push(await look());
    seen.push(await look());
    expect(seen.map((v) => (v.kind === 'WAIT' ? v.detail : v.kind))).toEqual([
      'INDEX_SCANNING',
      'GATEWAY',
      'INDEX_STALE',
      'CONFIRMED',
    ]);
    // Our transaction is the 1501st from the top: 16 pages, plus the failed and the empty one.
    expect(gateway.callCount('getTransactions')).toBe(Math.ceil(1_501 / SCAN_PAGE_SIZE) + 2);
  });
});
