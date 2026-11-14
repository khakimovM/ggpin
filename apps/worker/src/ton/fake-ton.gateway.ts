import { setTimeout as sleep } from 'node:timers/promises';
import type { Address, Cell, Transaction } from '@ton/core';
import { rawAddress } from './ton-address';
import {
  TonGatewayError,
  type TonAccountState,
  type TonChainWitness,
  type TonGateway,
  type TonGatewayOperation,
  type TxPage,
} from './ton-gateway';
import { txRef } from './ton-tx-scan';
import { buildW5Data, type W5Data } from './ton-w5';
import { FakeChainState, type FakeDestinationScenario } from './fake-ton-state';

// The network face of the in-memory chain (FakeChainState) for dev (FULFILLMENT_DRY_RUN=true) and
// tests. It applies the REAL signed W5R1 messages the worker produces. The "death points" (a send
// that is lost, held back, or throws after it landed; a call that fails), the latency and the call
// counters let the tests reproduce what the network can do. It refuses to exist in production or
// with FULFILLMENT_DRY_RUN=false (plan §8), so it can never stand in for the real chain.

export type { FakeDestinationScenario } from './fake-ton-state';
export { FAKE_BOUNCE_COST_NANO } from './fake-ton-state';

/**
 * What the network does with the next `sendBoc`: LAND (accepted now), LOSE (never arrives), HOLD
 * (arrives on `releaseHeld`), LAND_THEN_THROW (accepted, but the call fails), THROW (fails, not sent).
 */
export type FakeSendScenario = 'LAND' | 'LOSE' | 'HOLD' | 'LAND_THEN_THROW' | 'THROW';

export interface FakeTonGatewayOptions {
  readonly production: boolean;
  readonly dryRun: boolean;
  readonly latencyMs?: number;
}

/** The parts of a wallet the fake chain needs (a `TonWallet` has them). */
export interface FakeWalletIdentity {
  readonly address: Address;
  readonly own: W5Data;
  readonly init: { readonly code: Cell; readonly data: Cell };
}

type FailReason = TonGatewayError['reason'];

export class FakeTonGateway implements TonGateway {
  readonly calls = new Map<TonGatewayOperation, number>();
  readonly sentBocs: Buffer[] = [];
  latencyMs: number;
  private readonly chain = new FakeChainState();
  private readonly sendScenarios: FakeSendScenario[] = [];
  private readonly failures = new Map<TonGatewayOperation, FailReason[]>();
  private readonly held: Buffer[] = [];

  constructor(options: FakeTonGatewayOptions) {
    if (options.production) throw new Error('FakeTonGateway is never built in production');
    if (!options.dryRun) {
      throw new Error('FakeTonGateway is built only with FULFILLMENT_DRY_RUN=true');
    }
    this.latencyMs = options.latencyMs ?? 0;
  }

  // ---- test and dev controls ------------------------------------------------------------------

  get chainTime(): number {
    return this.chain.chainTime;
  }

  /** Fixes the chain clock at `unixSec`; `ticking` lets it run on from there like a real chain. */
  setChainTime(unixSec: number, ticking = false): void {
    this.chain.setChainTime(unixSec, ticking);
  }

  /** Moves the chain clock; a ticking clock keeps ticking. */
  advance(seconds: number): void {
    this.chain.advance(seconds);
  }

  registerWallet(wallet: FakeWalletIdentity, balanceNano: bigint, deployed = true): void {
    const account = this.chain.account(wallet.address);
    account.status = deployed ? 'active' : 'uninitialized';
    account.balance = balanceNano;
    account.wallet = { own: wallet.own, seqno: wallet.own.seqno };
  }

  setBalance(address: Address, balanceNano: bigint): void {
    this.chain.account(address).balance = balanceNano;
  }

  balanceOf(address: Address): bigint {
    return this.chain.find(address)?.balance ?? 0n;
  }

  freeze(address: Address): void {
    this.chain.account(address).status = 'frozen';
  }

  nextSend(...scenarios: FakeSendScenario[]): void {
    this.sendScenarios.push(...scenarios);
  }

  destination(address: Address, scenario: FakeDestinationScenario): void {
    this.chain.destinations.set(rawAddress(address), scenario);
  }

  failNext(operation: TonGatewayOperation, times = 1, reason: FailReason = 'NETWORK'): void {
    const list = this.failures.get(operation) ?? [];
    for (let i = 0; i < times; i += 1) list.push(reason);
    this.failures.set(operation, list);
  }

  /** The index lags: the `count` newest transactions of `address` are not listed (state is). */
  hideNewest(address: Address, count: number): void {
    this.chain.account(address).hidden = count;
  }

  /** Held messages reach the chain now (at the current chain time: an expired one is dropped). */
  releaseHeld(): void {
    for (const boc of this.held.splice(0)) this.chain.accept(boc);
  }

  /** `count` inbound dust transfers to `address` (audit H1). */
  receiveSpam(address: Address, count: number, valueNano = 1n): void {
    this.chain.receiveSpam(address, count, valueNano);
  }

  consumeSeqnoForeign(address: Address): void {
    this.chain.consumeSeqnoForeign(address);
  }

  callCount(operation: TonGatewayOperation): number {
    return this.calls.get(operation) ?? 0;
  }

  transactionsOf(address: Address): readonly Transaction[] {
    return [...(this.chain.find(address)?.txs ?? [])];
  }

  // ---- TonGateway -------------------------------------------------------------------------------

  async getAccountState(address: Address): Promise<TonAccountState> {
    await this.enter('getAccountState');
    const account = this.chain.find(address);
    const last = account?.txs.at(-1);
    const wallet = account?.wallet ?? null;
    return {
      status: account?.status ?? 'uninitialized',
      balanceNano: account?.balance ?? 0n,
      data:
        account?.status === 'active' && wallet !== null
          ? buildW5Data(wallet.own, wallet.seqno).toBoc()
          : null,
      chainTime: this.chain.chainTime,
      lastTx: last === undefined ? null : txRef(last),
    };
  }

  async getBalance(address: Address): Promise<bigint> {
    await this.enter('getBalance');
    return this.chain.find(address)?.balance ?? 0n;
  }

  async sendBoc(boc: Buffer): Promise<void> {
    await this.enter('sendBoc');
    this.sentBocs.push(Buffer.from(boc));
    const scenario = this.sendScenarios.shift() ?? 'LAND';
    if (scenario === 'THROW') throw new TonGatewayError('sendBoc', 'NETWORK');
    if (scenario === 'HOLD') this.held.push(Buffer.from(boc));
    if (scenario === 'LAND' || scenario === 'LAND_THEN_THROW') this.chain.accept(boc);
    if (scenario === 'LAND_THEN_THROW') throw new TonGatewayError('sendBoc', 'TIMEOUT');
  }

  /** Newest first; with `at` from that transaction down (a hidden one is not listed). */
  async getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    await this.enter('getTransactions');
    const at = page.at;
    return this.chain
      .visible(address)
      .reverse()
      .filter((tx) => at === undefined || tx.lt <= at.lt)
      .slice(0, page.limit);
  }

  /**
   * The in-memory chain has one "node": a fresh connection reads what every other read does
   * (subclasses of the tests model a lagging node behind a kept-alive connection). Counted.
   */
  freshConnection(): TonChainWitness {
    this.calls.set('freshConnection', this.callCount('freshConnection') + 1);
    return {
      getAccountState: (address) => this.getAccountState(address),
      getTransactions: (address, page) => this.getTransactions(address, page),
    };
  }

  async findResultTx(
    source: Address,
    destination: Address,
    createdLt: bigint,
  ): Promise<Transaction | null> {
    await this.enter('findResultTx');
    const found = this.chain.visible(destination).find((tx) => {
      const info = tx.inMessage?.info;
      return info?.type === 'internal' && info.src.equals(source) && info.createdLt === createdLt;
    });
    return found ?? null;
  }

  private async enter(operation: TonGatewayOperation): Promise<void> {
    this.calls.set(operation, this.callCount(operation) + 1);
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const reason = this.failures.get(operation)?.shift();
    if (reason !== undefined) throw new TonGatewayError(operation, reason);
  }
}
