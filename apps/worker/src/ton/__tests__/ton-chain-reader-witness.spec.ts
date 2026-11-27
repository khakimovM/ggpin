import { randomBytes } from 'node:crypto';
import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { Address, beginCell } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import { rawAddress } from '../ton-address';
import { TonChainReader } from '../ton-chain-reader';
import type { TonVerdict } from '../ton-classifier';
import type { TonChainWitness } from '../ton-gateway';
import type { TonTiming } from '../ton-tokens';
import type { StoredTransfer } from '../ton-transfer.repository';
import { buildW5Data } from '../ton-w5';
import { dryRunTonWallet, type TonWallet } from '../ton-wallet';

// Expiry witnesses (review m3, D-60 (2)): a second chain source, behind the narrow TonChainWitness
// interface, must agree before an EXPIRY observation counts. A witness that sees our message, or
// the seqno used, contradicts the primary source: WITNESS_CONFLICT (the order goes to review, a
// critical alert), never EXPIRED. A witness that cannot tell yet is a WAIT. Once it conflicted, the
// same process keeps answering WITNESS_CONFLICT for that transfer (review RR2-4).

const TON = 1_000_000_000n;
const T0 = 1_800_000_000;
const VALID_SEC = 60;
const PAST = T0 + VALID_SEC + TON_NOT_SENT_MARGIN_MS / 1_000 + 10;
const TIMING: TonTiming = {
  pollMs: 10,
  destGraceSec: 20,
  confirmTimeoutMs: 300_000,
  lockTtlMs: 120_000,
  maxClockSkewSec: 60,
  expiryGapSec: 30,
};

interface Case {
  /** The primary source: our message never reached it (lost). */
  readonly primary: FakeTonGateway;
  /** A second chain the witnesses read; by default the same as the primary's. */
  readonly other: FakeTonGateway;
  readonly wallet: TonWallet;
  readonly transfer: StoredTransfer;
  readonly boc: Buffer;
}

function chainFor(wallet: TonWallet): FakeTonGateway {
  const gateway = new FakeTonGateway({ production: false, dryRun: true });
  gateway.registerWallet(wallet, 10n * TON);
  gateway.setChainTime(T0);
  return gateway;
}

function lostMessage(): Case {
  const wallet = dryRunTonWallet('testnet');
  const primary = chainFor(wallet);
  const other = chainFor(wallet);
  const payee = new Address(0, randomBytes(32));
  const body = beginCell().storeUint(0, 32).storeStringTail('order').endCell();
  const signed = wallet.sign({
    seqno: 0,
    validUntilSec: T0 + VALID_SEC,
    to: payee,
    amountNano: TON,
    body,
    bounce: true,
    deploy: false,
  });
  const transfer: StoredTransfer = {
    id: 'cm0witness1',
    purpose: 'ORDER',
    attemptId: 'a1',
    network: 'testnet',
    walletAddress: wallet.rawAddress,
    seqno: 0,
    validUntil: new Date((T0 + VALID_SEC) * 1_000),
    toAddress: rawAddress(payee),
    amountNanoTon: TON,
    payloadHash: signed.payloadHash,
    extMsgHash: signed.extMsgHash,
    status: 'BROADCAST',
    txHash: null,
    createdAt: new Date(T0 * 1_000),
  };
  return { primary, other, wallet, transfer, boc: signed.boc };
}

/** Only the two reads a witness may make (a full gateway would also allow sendBoc). */
function witnessOf(gateway: FakeTonGateway): TonChainWitness {
  return {
    getAccountState: (address) => gateway.getAccountState(address),
    getTransactions: (address, page) => gateway.getTransactions(address, page),
  };
}

function lookPast(c: Case, witnesses: readonly TonChainWitness[]): Promise<TonVerdict> {
  c.primary.setChainTime(PAST);
  c.other.setChainTime(PAST);
  const reader = new TonChainReader(c.primary, c.wallet, TIMING, witnesses);
  return reader.examine(c.transfer, () => Promise.resolve(PAST * 1_000));
}

describe('TonChainReader: expiry witnesses (review m3)', () => {
  it('no witness, or one that sees the same: one EXPIRY observation', async () => {
    const c = lostMessage();
    expect((await lookPast(c, [])).kind).toBe('EXPIRY_SEEN');
    expect((await lookPast(c, [witnessOf(c.other)])).kind).toBe('EXPIRY_SEEN');
    expect(c.other.callCount('getAccountState')).toBe(1);
    expect(c.other.callCount('sendBoc')).toBe(0);
  });

  it('a witness that finds our message: WITNESS_CONFLICT FOUND, never EXPIRY_SEEN', async () => {
    const c = lostMessage();
    await c.other.sendBoc(c.boc);
    expect(await lookPast(c, [witnessOf(c.other)])).toEqual({
      kind: 'WITNESS_CONFLICT',
      detail: 'FOUND',
      witness: 0,
    });
  });

  it('a witness that sees the seqno used by another message: WITNESS_CONFLICT SEQNO_MOVED', async () => {
    const c = lostMessage();
    c.other.consumeSeqnoForeign(c.wallet.address);
    expect(await lookPast(c, [witnessOf(c.other)])).toEqual({
      kind: 'WITNESS_CONFLICT',
      detail: 'SEQNO_MOVED',
      witness: 0,
    });
  });

  it('the second of two witnesses conflicts: its index is named', async () => {
    const c = lostMessage();
    const third = chainFor(c.wallet);
    await third.sendBoc(c.boc);
    third.setChainTime(PAST);
    expect(await lookPast(c, [witnessOf(c.other), witnessOf(third)])).toEqual({
      kind: 'WITNESS_CONFLICT',
      detail: 'FOUND',
      witness: 1,
    });
  });

  it('review RR2-4: after one conflict this process answers WITNESS_CONFLICT again, even when the witness agrees', async () => {
    const c = lostMessage();
    // The witness reads the same chain; its first account state shows the seqno as used.
    let moved = 1;
    const flip: TonChainWitness = {
      getAccountState: async (address) => {
        const real = await c.other.getAccountState(address);
        if (moved <= 0) return real;
        moved -= 1;
        return { ...real, data: buildW5Data(c.wallet.own, 1).toBoc() };
      },
      getTransactions: (address, page) => c.other.getTransactions(address, page),
    };
    c.primary.setChainTime(PAST);
    c.other.setChainTime(PAST);
    const reader = new TonChainReader(c.primary, c.wallet, TIMING, [flip]);
    const look = () => reader.examine(c.transfer, () => Promise.resolve(PAST * 1_000));
    const conflict = { kind: 'WITNESS_CONFLICT', detail: 'SEQNO_MOVED', witness: 0 };
    expect(await look()).toEqual(conflict);
    const reads = c.other.callCount('getAccountState');
    expect(await look()).toEqual(conflict);
    expect(c.other.callCount('getAccountState')).toBe(reads);
    // A restart forgets it: the conflict kept on the attempt bars EXPIRED in the write layer.
    reader.forget(c.transfer.id);
    expect((await look()).kind).toBe('EXPIRY_SEEN');
  });

  it('a witness with a lagging index or a failing read cannot tell: a WAIT', async () => {
    const lagging = lostMessage();
    await lagging.other.sendBoc(lagging.boc);
    lagging.other.hideNewest(lagging.wallet.address, 1);
    expect(await lookPast(lagging, [witnessOf(lagging.other)])).toEqual({
      kind: 'WAIT',
      detail: 'WITNESS_PENDING',
    });
    const failing = lostMessage();
    failing.other.failNext('getAccountState', 1, 'HTTP');
    expect(await lookPast(failing, [witnessOf(failing.other)])).toEqual({
      kind: 'WAIT',
      detail: 'GATEWAY',
    });
  });
});
