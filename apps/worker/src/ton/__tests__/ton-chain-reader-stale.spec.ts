import { randomBytes } from 'node:crypto';
import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { Address, beginCell, type Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import { rawAddress } from '../ton-address';
import { TonChainReader } from '../ton-chain-reader';
import type { TonVerdict } from '../ton-classifier';
import type { TonAccountState, TonChainWitness, TxPage } from '../ton-gateway';
import type { TonTiming } from '../ton-tokens';
import type { StoredTransfer } from '../ton-transfer.repository';
import { dryRunTonWallet, type TonWallet } from '../ton-wallet';

// Audit M-1: a node that serves an account state from BEFORE our transaction (old seqno, old last
// transaction) with a CURRENT chain time. (a) The index of the same connection already lists our
// transaction as its newest: the state is stale, so no pass may rest on it. (b) A node stale in
// both the state and the index, reached again and again over one kept-alive connection: the
// reads that confirm an EXPIRY observation go over a fresh connection, which reaches another node.

const TON = 1_000_000_000n;
const T0 = 1_800_000_000;
const VALID_SEC = 60;
const MARGIN_SEC = TON_NOT_SENT_MARGIN_MS / 1_000;
const TIMING: TonTiming = {
  pollMs: 10,
  destGraceSec: 20,
  confirmTimeoutMs: 300_000,
  lockTtlMs: 120_000,
  maxClockSkewSec: 60,
  expiryGapSec: 30,
};

/** The kept-alive connection's node: frozen at a past moment (state, and the listing if asked). */
class StaleNodeGateway extends FakeTonGateway {
  frozenState: TonAccountState | null = null;
  frozenTxs: readonly Transaction[] | null = null;
  /** A fresh connection reaches an up-to-date node (false: every node is the stale one). */
  freshIsCurrent = false;
  freshConnections = 0;

  override async getAccountState(address: Address): Promise<TonAccountState> {
    const real = await super.getAccountState(address);
    return this.frozenState === null ? real : { ...this.frozenState, chainTime: real.chainTime };
  }

  override async getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    const real = await super.getTransactions(address, page);
    const frozen = this.frozenTxs;
    if (frozen === null) return real;
    const at = page.at;
    return [...frozen]
      .reverse()
      .filter((tx) => at === undefined || tx.lt <= at.lt)
      .slice(0, page.limit);
  }

  override freshConnection(): TonChainWitness {
    this.freshConnections += 1;
    if (!this.freshIsCurrent) return super.freshConnection();
    return {
      getAccountState: (address) => super.getAccountState(address),
      getTransactions: (address, page) => super.getTransactions(address, page),
    };
  }

  unfreeze(): void {
    this.frozenState = null;
    this.frozenTxs = null;
  }
}

interface Case {
  readonly gateway: StaleNodeGateway;
  readonly wallet: TonWallet;
  readonly transfer: StoredTransfer;
  readonly reader: TonChainReader;
}

/** Our payout lands; the node is frozen at the moment right before it. */
async function landedBehindStaleNode(history: number, staleIndex: boolean): Promise<Case> {
  const gateway = new StaleNodeGateway({ production: false, dryRun: true });
  const wallet = dryRunTonWallet('testnet');
  gateway.registerWallet(wallet, 100n * TON);
  gateway.setChainTime(T0 - 1_000);
  if (history > 0) gateway.receiveSpam(wallet.address, history);
  gateway.setChainTime(T0);
  const before = await gateway.getAccountState(wallet.address);
  const beforeTxs = gateway.transactionsOf(wallet.address);
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
  await gateway.sendBoc(signed.boc);
  gateway.frozenState = before;
  if (staleIndex) gateway.frozenTxs = beforeTxs;
  const transfer: StoredTransfer = {
    id: `stale-${randomBytes(4).toString('hex')}`,
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
  return { gateway, wallet, transfer, reader: new TonChainReader(gateway, wallet, TIMING, []) };
}

/** One look at chain time `at` (the database clock equal to it). */
function lookAt(c: Case, at: number): Promise<TonVerdict> {
  c.gateway.setChainTime(at);
  return c.reader.examine(c.transfer, () => Promise.resolve(at * 1_000));
}

const PAST = T0 + VALID_SEC + MARGIN_SEC + 80;

describe('TonChainReader: a stale account state (audit M-1)', () => {
  it.each([0, 3])(
    '(a) state stale, index current (wallet history %i): no EXPIRY observation, ever',
    async (history) => {
      const c = await landedBehindStaleNode(history, false);
      const first = await lookAt(c, PAST);
      const second = await lookAt(c, PAST + 40);
      expect([first.kind, second.kind]).toEqual(['WAIT', 'WAIT']);
      expect(first).toEqual({ kind: 'WAIT', detail: 'INDEX_STALE' });
      // The node catches up: our transaction is found and the payout is confirmed.
      c.gateway.unfreeze();
      expect(await lookAt(c, PAST + 80)).toMatchObject({ kind: 'CONFIRMED' });
    },
  );

  it('(b) state AND index stale on the kept-alive connection: the fresh connection sees the truth', async () => {
    const c = await landedBehindStaleNode(3, true);
    c.gateway.freshIsCurrent = true;
    const seen = [await lookAt(c, PAST), await lookAt(c, PAST + 40), await lookAt(c, PAST + 80)];
    expect(seen.map((v) => v.kind)).toEqual(['WAIT', 'WAIT', 'WAIT']);
    // Every look that would have been an observation asked a NEW connection first.
    expect(c.gateway.freshConnections).toBe(3);
    c.gateway.unfreeze();
    expect(await lookAt(c, PAST + 120)).toMatchObject({ kind: 'CONFIRMED' });
  });
});
