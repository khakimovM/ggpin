import { randomBytes } from 'node:crypto';
import { Address, beginCell, type Cell } from '@ton/core';
import { classifyNotFound, classifyOurTx } from '../ton-classifier';
import { FAKE_BOUNCE_COST_NANO, FakeTonGateway } from '../fake-ton.gateway';
import { TonGatewayError } from '../ton-gateway';
import { rawAddress } from '../ton-address';
import {
  abortedWithoutBounce,
  bounceSentBack,
  processedOurMessage,
  returnTxOf,
} from '../ton-tx-facts';
import { NO_PROGRESS, advanceScan, type ScanStep } from '../ton-tx-scan';
import { w5ViewOf } from '../ton-w5';
import { dryRunTonWallet, type TonWallet } from '../ton-wallet';

// The fake chain applies REAL signed W5R1 messages like the wallet contract does (signature,
// wallet id, seqno, valid_until), and its transactions are real @ton/core cells that the scan and
// the classifier read exactly as toncenter's would be read.

const TON = 1_000_000_000n;
const NOW = 1_800_000_000;

function randomAccount(): Address {
  return new Address(0, randomBytes(32));
}

function payload(text = 'order payload'): Cell {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell();
}

describe('FakeTonGateway', () => {
  let gateway: FakeTonGateway;
  let wallet: TonWallet;
  let fragment: Address;

  beforeEach(() => {
    gateway = new FakeTonGateway({ production: false, dryRun: true });
    gateway.setChainTime(NOW);
    wallet = dryRunTonWallet('testnet');
    gateway.registerWallet(wallet, 10n * TON);
    fragment = randomAccount();
  });

  function sign(seqno: number, amountNano = TON, validUntilSec = NOW + 60, body = payload()) {
    return wallet.sign({
      seqno,
      validUntilSec,
      to: fragment,
      amountNano,
      body,
      bounce: true,
      deploy: false,
    });
  }

  async function seqno(): Promise<number | null> {
    const view = w5ViewOf(await gateway.getAccountState(wallet.address), wallet.own);
    return view.ready ? view.seqno : null;
  }

  /** The time-bounded scan run to its end (as many looks as it takes). */
  async function search(extMsgHash: string): Promise<ScanStep> {
    let progress = NO_PROGRESS;
    for (;;) {
      const state = await gateway.getAccountState(wallet.address);
      const step = await advanceScan(
        {
          fetchPage: (page) => gateway.getTransactions(wallet.address, page),
          address: wallet.address,
          extMsgHash,
          sinceUtime: NOW - 600,
        },
        progress,
        () => Promise.resolve({ state, atMs: null }),
      );
      if (step.kind !== 'PARTIAL') return step;
      progress = step.progress;
    }
  }

  it('refuses to exist in production or with FULFILLMENT_DRY_RUN=false', () => {
    expect(() => new FakeTonGateway({ production: true, dryRun: true })).toThrow(/production/);
    expect(() => new FakeTonGateway({ production: false, dryRun: false })).toThrow(/DRY_RUN/);
  });

  it('lands a signed transfer: seqno moves, our transaction pays exactly the signed message', async () => {
    const signed = sign(0);
    await gateway.sendBoc(signed.boc);
    expect(await seqno()).toBe(1);
    const found = await search(signed.extMsgHash);
    expect(found.kind).toBe('FOUND');
    if (found.kind !== 'FOUND') return;
    const facts = {
      seqno: 0,
      validUntilSec: NOW + 60,
      toAddress: rawAddress(fragment),
      amountNano: TON,
      payloadHash: signed.payloadHash,
    };
    const paid = classifyOurTx(facts, found.tx);
    expect(paid.kind).toBe('PAID');
    if (paid.kind !== 'PAID') return;
    const destTx = await gateway.findResultTx(wallet.address, fragment, paid.out.createdLt);
    expect(destTx).not.toBeNull();
    if (destTx === null) return;
    expect(processedOurMessage(destTx, wallet.address, paid.out)).toBe(true);
    expect(gateway.balanceOf(fragment)).toBe(TON);
  });

  it('never accepts the same signed message twice (the seqno moved)', async () => {
    const signed = sign(0);
    await gateway.sendBoc(signed.boc);
    await gateway.sendBoc(signed.boc);
    expect(await seqno()).toBe(1);
    expect(gateway.transactionsOf(wallet.address)).toHaveLength(1);
  });

  it('refuses an expired message, a wrong seqno and a foreign signature', async () => {
    await gateway.sendBoc(sign(0, TON, NOW).boc); // valid_until must be AFTER now
    await gateway.sendBoc(sign(1).boc);
    const stranger = dryRunTonWallet('testnet');
    const forged = stranger.sign({
      seqno: 0,
      validUntilSec: NOW + 60,
      to: fragment,
      amountNano: TON,
      body: payload(),
      bounce: true,
      deploy: false,
    });
    // The stranger's message addressed to its own wallet: not registered, so nothing happens.
    await gateway.sendBoc(forged.boc);
    expect(await seqno()).toBe(0);
    expect(gateway.transactionsOf(wallet.address)).toHaveLength(0);
  });

  it('skips a send the balance cannot pay: the transaction has no outgoing message', async () => {
    gateway.setBalance(wallet.address, TON / 2n);
    const signed = sign(0, TON);
    await gateway.sendBoc(signed.boc);
    const found = await search(signed.extMsgHash);
    expect(found.kind).toBe('FOUND');
    if (found.kind !== 'FOUND') return;
    const step = classifyOurTx(
      {
        seqno: 0,
        validUntilSec: NOW + 60,
        toAddress: rawAddress(fragment),
        amountNano: TON,
        payloadHash: signed.payloadHash,
      },
      found.tx,
    );
    expect(step).toMatchObject({ kind: 'SUSPECT', detail: 'NO_OUT_MESSAGE' });
  });

  it('a bouncing destination sends the value back in a transaction of our wallet', async () => {
    gateway.destination(fragment, 'BOUNCE');
    const signed = sign(0);
    await gateway.sendBoc(signed.boc);
    const [ours] = gateway.transactionsOf(wallet.address);
    expect(ours).toBeDefined();
    const out = [...(ours?.outMessages.values() ?? [])][0];
    if (out?.info.type !== 'internal') throw new Error('expected an internal out message');
    const destTx = await gateway.findResultTx(wallet.address, fragment, out.info.createdLt);
    if (destTx === null) throw new Error('expected the destination transaction');
    const bounce = bounceSentBack(destTx, wallet.address);
    expect(bounce).not.toBeNull();
    if (bounce === null) return;
    expect(bounce.valueNano).toBe(TON - FAKE_BOUNCE_COST_NANO);
    const back = await gateway.findResultTx(fragment, wallet.address, bounce.createdLt);
    if (back === null) throw new Error('expected the return transaction');
    expect(returnTxOf(back, wallet.address, rawAddress(fragment), bounce)).toMatchObject({
      returnedNano: TON - FAKE_BOUNCE_COST_NANO,
    });
  });

  it('a destination that aborts without bouncing keeps the value', async () => {
    gateway.destination(fragment, 'ABORT_NO_BOUNCE');
    await gateway.sendBoc(sign(0).boc);
    const destTx = gateway.transactionsOf(fragment)[0];
    if (destTx === undefined) throw new Error('expected the destination transaction');
    expect(abortedWithoutBounce(destTx, wallet.address)).toBe(true);
  });

  it('a foreign message consuming the seqno: ours is not found, the seqno moved past it', async () => {
    const signed = sign(0);
    gateway.consumeSeqnoForeign(wallet.address);
    await gateway.sendBoc(signed.boc); // now the wrong seqno: refused
    const result = await search(signed.extMsgHash);
    expect(result.kind).toBe('COMPLETE');
    const facts = {
      seqno: 0,
      validUntilSec: NOW + 60,
      toAddress: rawAddress(fragment),
      amountNano: TON,
      payloadHash: signed.payloadHash,
    };
    expect(classifyNotFound(facts, await seqno(), NOW)).toEqual({
      kind: 'CONSUMED_UNMATCHED',
      walletSeqno: 1,
    });
  });

  it('a lagging index makes "not found" inconclusive', async () => {
    await gateway.sendBoc(sign(0).boc);
    gateway.hideNewest(wallet.address, 1);
    const result = await search(sign(1).extMsgHash);
    expect(result.kind).toBe('STALE');
  });

  it('a held message reaching the chain after valid_until is dropped', async () => {
    gateway.nextSend('HOLD');
    await gateway.sendBoc(sign(0).boc);
    gateway.advance(120);
    gateway.releaseHeld();
    expect(await seqno()).toBe(0);
  });

  it('deploys an uninitialized wallet with its own StateInit', async () => {
    const fresh = dryRunTonWallet('testnet');
    gateway.registerWallet(fresh, 5n * TON, false);
    const signed = fresh.sign({
      seqno: 0,
      validUntilSec: NOW + 60,
      to: fragment,
      amountNano: TON,
      body: payload(),
      bounce: true,
      deploy: true,
    });
    await gateway.sendBoc(signed.boc);
    const state = await gateway.getAccountState(fresh.address);
    expect(state.status).toBe('active');
    expect(w5ViewOf(state, fresh.own)).toEqual({ ready: true, seqno: 1, deploy: false });
  });

  it('death points: failing calls, a send that throws after landing, call counters', async () => {
    gateway.failNext('getAccountState', 1, 'TIMEOUT');
    await expect(gateway.getAccountState(wallet.address)).rejects.toThrow(TonGatewayError);
    gateway.nextSend('LAND_THEN_THROW', 'THROW');
    await expect(gateway.sendBoc(sign(0).boc)).rejects.toThrow(TonGatewayError);
    expect(await seqno()).toBe(1); // it landed anyway
    await expect(gateway.sendBoc(sign(1).boc)).rejects.toThrow(TonGatewayError);
    expect(await seqno()).toBe(1); // this one did not
    expect(gateway.callCount('sendBoc')).toBe(2);
    expect(gateway.sentBocs).toHaveLength(2);
  });
});
