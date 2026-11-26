import { randomBytes } from 'node:crypto';
import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { Address, beginCell } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import { rawAddress } from '../ton-address';
import { TonChainReader } from '../ton-chain-reader';
import type { TonVerdict } from '../ton-classifier';
import type { TonTiming } from '../ton-tokens';
import type { StoredTransfer } from '../ton-transfer.repository';
import { SCAN_PAGE_SIZE } from '../ton-tx-scan';
import { dryRunTonWallet, type TonWallet } from '../ton-wallet';

// The time-bounded scan through the reader (audit H1): inbound dust spam after our transaction
// only makes the scan take more looks, never "not found", and an incomplete window decides
// nothing. Also: the destination's grace starts at the first SUCCESSFUL "not found" (review M1),
// and a destination transaction once seen is never forgotten by a lagging node.

const TON = 1_000_000_000n;
const NOW = 1_800_000_000;
const VALID_SEC = 60;
const MARGIN_SEC = TON_NOT_SENT_MARGIN_MS / 1_000;
const TIMING: TonTiming = {
  pollMs: 10,
  destGraceSec: 20,
  confirmTimeoutMs: 180_000,
  lockTtlMs: 120_000,
  maxClockSkewSec: 60,
  expiryGapSec: 30,
};
/** A database clock far past every validUntil + margin of these tests. */
const dbLate = () => Promise.resolve((NOW + 3_600) * 1_000);

describe('TonChainReader', () => {
  let gateway: FakeTonGateway;
  let wallet: TonWallet;
  let reader: TonChainReader;
  let fragment: Address;
  /** The BOC of the last stored() transfer: broadcast only when a test says so. */
  let lastBoc: Buffer = Buffer.alloc(0);

  beforeEach(() => {
    gateway = new FakeTonGateway({ production: false, dryRun: true });
    gateway.setChainTime(NOW);
    wallet = dryRunTonWallet('testnet');
    gateway.registerWallet(wallet, 10n * TON);
    fragment = new Address(0, randomBytes(32));
    reader = new TonChainReader(gateway, wallet, TIMING, []);
  });

  function stored(seqno = 0): StoredTransfer {
    const body = beginCell().storeUint(0, 32).storeStringTail('order').endCell();
    const signed = wallet.sign({
      seqno,
      validUntilSec: NOW + VALID_SEC,
      to: fragment,
      amountNano: TON,
      body,
      bounce: true,
      deploy: false,
    });
    lastBoc = signed.boc;
    return {
      id: `t${String(seqno)}`,
      purpose: 'ORDER',
      attemptId: 'a1',
      network: 'testnet',
      walletAddress: wallet.rawAddress,
      seqno,
      validUntil: new Date((NOW + VALID_SEC) * 1_000),
      toAddress: rawAddress(fragment),
      amountNanoTon: TON,
      payloadHash: signed.payloadHash,
      extMsgHash: signed.extMsgHash,
      status: 'SIGNED',
      txHash: null,
      createdAt: new Date(NOW * 1_000),
    };
  }
  /** Looks until the verdict is no longer "still scanning"; returns every verdict seen. */
  async function lookUntilDecided(transfer: StoredTransfer, limit = 50): Promise<TonVerdict[]> {
    const seen: TonVerdict[] = [];
    for (let look = 0; look < limit; look += 1) {
      const verdict = await reader.examine(transfer, dbLate);
      seen.push(verdict);
      if (verdict.kind !== 'WAIT' || verdict.detail !== 'INDEX_SCANNING') return seen;
    }
    return seen;
  }

  it.each([128, 1_000])(
    '%i inbound spam transfers after ours: still found and CONFIRMED',
    async (count) => {
      const transfer = stored();
      await gateway.sendBoc(lastBoc);
      gateway.receiveSpam(wallet.address, count);
      const seen = await lookUntilDecided(transfer);
      expect(seen.at(-1)).toMatchObject({ kind: 'CONFIRMED' });
      // Every look before the verdict said "still scanning", never "not found".
      expect(seen.slice(0, -1).every((v) => v.kind === 'WAIT')).toBe(true);
    },
  );

  it.each([128, 1_000])(
    'a lost message under %i spam: WAIT while scanning, then one EXPIRY observation',
    async (count) => {
      const transfer = stored();
      gateway.receiveSpam(wallet.address, count);
      gateway.setChainTime(NOW + VALID_SEC + MARGIN_SEC + 1);
      const seen = await lookUntilDecided(transfer);
      expect(seen.at(-1)).toMatchObject({
        kind: 'EXPIRY_SEEN',
        observation: { seqno: 0, chainTime: NOW + VALID_SEC + MARGIN_SEC + 1 },
      });
      if (count > 128) expect(seen.length).toBeGreaterThan(1);
    },
  );

  it.each([128, 1_000])(
    'a seqno consumed by a foreign message under %i spam: CONSUMED_UNMATCHED',
    async (count) => {
      const transfer = stored();
      gateway.consumeSeqnoForeign(wallet.address);
      gateway.receiveSpam(wallet.address, count);
      const seen = await lookUntilDecided(transfer);
      expect(seen.at(-1)).toEqual({ kind: 'CONSUMED_UNMATCHED', walletSeqno: 1 });
      expect(seen.slice(0, -1).every((v) => v.kind === 'WAIT')).toBe(true);
    },
  );

  it('the window ends at createdAt minus the slack: old history is not read', async () => {
    gateway.setChainTime(NOW - 3_600);
    gateway.receiveSpam(wallet.address, 600); // an hour before the transfer: outside the window
    gateway.setChainTime(NOW);
    const transfer = stored();
    gateway.receiveSpam(wallet.address, 200); // inside the window: read in full
    gateway.setChainTime(NOW + VALID_SEC + MARGIN_SEC + 1);
    const seen = await lookUntilDecided(transfer);
    expect(seen.at(-1)).toMatchObject({ kind: 'EXPIRY_SEEN' });
    // 200 in the window + the first older one: 3 pages of 100 (the first is the head listing),
    // not the 9 of the whole history; + 1: the fresh connection's head (audit M-1 (b)).
    expect(gateway.callCount('getTransactions')).toBe(Math.ceil(201 / SCAN_PAGE_SIZE) + 1);
  });

  it('a lagging index is never "not found": WAIT INDEX_STALE', async () => {
    const transfer = stored();
    await gateway.sendBoc(lastBoc);
    gateway.hideNewest(wallet.address, 1);
    gateway.setChainTime(NOW + VALID_SEC + MARGIN_SEC + 1);
    expect(await reader.examine(transfer, dbLate)).toEqual({ kind: 'WAIT', detail: 'INDEX_STALE' });
  });

  it('an expiry needs the database clock past validUntil + the margin too', async () => {
    const transfer = stored();
    gateway.setChainTime(NOW + VALID_SEC + MARGIN_SEC + 1);
    const dbEarly = () => Promise.resolve((NOW + VALID_SEC) * 1_000);
    expect(await reader.examine(transfer, dbEarly)).toEqual({
      kind: 'WAIT',
      detail: 'DB_CLOCK_BEHIND',
    });
  });

  it('a failing destination lookup is a WAIT; the grace starts at the first real "not found"', async () => {
    gateway.destination(fragment, 'SILENT');
    const transfer = stored();
    await gateway.sendBoc(lastBoc);
    gateway.failNext('findResultTx', 1, 'HTTP');
    gateway.setChainTime(NOW + 100);
    expect(await reader.examine(transfer, dbLate)).toEqual({ kind: 'WAIT', detail: 'GATEWAY' });
    // First successful "not found" at NOW + 100 (our transaction is at NOW: that is not the start).
    expect(await reader.examine(transfer, dbLate)).toEqual({
      kind: 'WAIT',
      detail: 'DESTINATION_PENDING',
    });
    gateway.setChainTime(NOW + 119);
    expect((await reader.examine(transfer, dbLate)).kind).toBe('WAIT');
    gateway.setChainTime(NOW + 120);
    expect(await reader.examine(transfer, dbLate)).toMatchObject({ kind: 'CONFIRMED' });
  });

  it('a bounce once seen stays seen when a lagging node later answers "not found"', async () => {
    gateway.destination(fragment, 'BOUNCE');
    const transfer = stored();
    await gateway.sendBoc(lastBoc);
    const first = await reader.examine(transfer, dbLate);
    expect(first).toMatchObject({ kind: 'BOUNCED' });
    // The destination's transaction disappears from the index (another backend node).
    gateway.hideNewest(fragment, 1);
    gateway.setChainTime(NOW + 1_000);
    expect(await reader.examine(transfer, dbLate)).toMatchObject({ kind: 'BOUNCED' });
  });
});
