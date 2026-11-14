import {
  Cell,
  beginCell,
  contractAddress,
  external,
  loadMessage,
  type Address,
  type Message,
  type Transaction,
} from '@ton/core';
import { rawAddress } from './ton-address';
import type { W5Data } from './ton-w5';
import {
  FAKE_FWD_FEE_NANO,
  FAKE_TX_FEE_NANO,
  bounceOf,
  buildTx,
  genericDescription,
  isSignedExternal,
  parseW5Request,
  sentInternal,
} from './fake-ton-chain';

// The accounts, the clock and the logical time of the fake chain (FakeTonGateway is its network
// face). `accept` is what the W5R1 wallet contract does with an inbound external message: the
// signature, the wallet id, the seqno and `valid_until` are checked like wallet-contract-v5 checks
// them, a send the balance cannot pay is skipped (the wallet always sends with IGNORE_ERRORS), and
// every out message reaches its destination, which processes, bounces or aborts it as told.

/** What a destination does with the value it receives. */
export type FakeDestinationScenario = 'PROCESS' | 'BOUNCE' | 'ABORT_NO_BOUNCE' | 'SILENT';

export interface FakeAccount {
  readonly address: Address;
  status: 'active' | 'uninitialized' | 'frozen';
  balance: bigint;
  wallet: { readonly own: W5Data; seqno: number } | null;
  /** Oldest first. */
  readonly txs: Transaction[];
  /** The index lags behind: this many newest transactions are not listed yet. */
  hidden: number;
}

/** A bounce costs the destination's gas and the forward fee of the way back. */
export const FAKE_BOUNCE_COST_NANO = FAKE_TX_FEE_NANO + FAKE_FWD_FEE_NANO;

type Description = ReturnType<typeof genericDescription>;

export class FakeChainState {
  readonly destinations = new Map<string, FakeDestinationScenario>();
  private readonly accounts = new Map<string, FakeAccount>();
  private clock: {
    readonly base: number;
    readonly ticking: boolean;
    readonly setAtMs: number;
  } | null = null;
  private lt = 1_000_000n;

  /**
   * The chain's clock (unix seconds): the wall clock until a test sets it; a set clock stands
   * still, or ticks on from the set time (the two-observation EXPIRED proof needs a moving chain).
   */
  get chainTime(): number {
    const clock = this.clock;
    if (clock === null) return Math.floor(Date.now() / 1_000);
    if (!clock.ticking) return clock.base;
    return clock.base + Math.floor((Date.now() - clock.setAtMs) / 1_000);
  }

  setChainTime(unixSec: number, ticking = false): void {
    this.clock = { base: unixSec, ticking, setAtMs: Date.now() };
  }

  advance(seconds: number): void {
    this.setChainTime(this.chainTime + seconds, this.clock?.ticking ?? false);
  }

  find(address: Address): FakeAccount | undefined {
    return this.accounts.get(rawAddress(address));
  }

  account(address: Address): FakeAccount {
    const key = rawAddress(address);
    let account = this.accounts.get(key);
    if (account === undefined) {
      account = { address, status: 'uninitialized', balance: 0n, wallet: null, txs: [], hidden: 0 };
      this.accounts.set(key, account);
    }
    return account;
  }

  /** Oldest first, without the transactions the index does not list yet. */
  visible(address: Address): Transaction[] {
    const account = this.find(address);
    if (account === undefined) return [];
    return account.txs.slice(0, Math.max(0, account.txs.length - account.hidden));
  }

  /** Someone else's message uses the wallet's current seqno (a leaked key, another tool). */
  consumeSeqnoForeign(address: Address): void {
    const account = this.account(address);
    if (account.wallet === null) throw new Error('not a wallet of the fake chain');
    const body = beginCell()
      .storeUint(0x7369676e, 32)
      .storeUint(account.wallet.seqno, 32)
      .endCell();
    account.wallet.seqno += 1;
    const description = genericDescription({ totalActions: 0 });
    this.append(account, external({ to: address, body }), [], description, FAKE_TX_FEE_NANO);
  }

  /**
   * Inbound transfers from a stranger, one transaction each (audit H1: dust spam that pushes our
   * transaction deep into the wallet's history; each costs the spammer a fee on the real chain).
   */
  receiveSpam(address: Address, count: number, valueNano: bigint): void {
    const account = this.account(address);
    const stranger = contractAddress(0, { code: Cell.EMPTY, data: Cell.EMPTY });
    for (let index = 0; index < count; index += 1) {
      const lt = this.nextLt();
      const message: Message = {
        info: {
          type: 'internal',
          ihrDisabled: true,
          bounce: false,
          bounced: false,
          src: stranger,
          dest: address,
          value: { coins: valueNano },
          ihrFee: 0n,
          forwardFee: FAKE_FWD_FEE_NANO,
          createdLt: lt - 1n,
          createdAt: this.chainTime,
        },
        init: null,
        body: Cell.EMPTY,
      };
      account.balance += valueNano;
      this.append(account, message, [], genericDescription(), 0n, lt);
    }
  }

  /** What the wallet contract does with an inbound external message (wallet-contract-v5). */
  accept(boc: Buffer): void {
    const root = Cell.fromBoc(boc)[0];
    if (root === undefined) return;
    const message = loadMessage(root.beginParse());
    if (message.info.type !== 'external-in') return;
    const account = this.find(message.info.dest);
    const wallet = account?.wallet ?? null;
    if (account === undefined || wallet === null || account.status === 'frozen') return;
    if (account.status === 'uninitialized' && !this.deploysItself(message, account)) return;
    const request = parseW5Request(message.body, wallet.own.publicKey);
    if (request === null || !request.validSignature || !isSignedExternal(request)) return;
    if (request.walletId !== wallet.own.walletId || request.seqno !== wallet.seqno) return;
    if (request.validUntil <= this.chainTime || account.balance < FAKE_TX_FEE_NANO) return;
    account.status = 'active';
    wallet.seqno += 1;
    account.balance -= FAKE_TX_FEE_NANO;
    const lt = this.nextLt();
    const outs: Message[] = [];
    request.messages.forEach((action, index) => {
      const createdLt = lt + BigInt(index) + 1n;
      const out = sentInternal(action.message, account.address, createdLt, this.chainTime);
      if (out?.info.type !== 'internal') return;
      const cost = out.info.value.coins + FAKE_FWD_FEE_NANO;
      if (account.balance < cost) return; // IGNORE_ERRORS: the action is skipped
      account.balance -= cost;
      outs.push(out);
    });
    const total = request.messages.length;
    this.lt += BigInt(total) + 1n;
    const description = genericDescription({
      totalActions: total,
      skippedActions: total - outs.length,
    });
    this.append(account, message, outs, description, FAKE_TX_FEE_NANO, lt);
    for (const out of outs) this.deliver(out, account);
  }

  private deploysItself(message: Message, account: FakeAccount): boolean {
    const init = message.init;
    if (init?.code == null || init.data == null) return false;
    return contractAddress(0, { code: init.code, data: init.data }).equals(account.address);
  }

  private deliver(out: Message, from: FakeAccount): void {
    if (out.info.type !== 'internal') return;
    const scenario = this.destinations.get(rawAddress(out.info.dest)) ?? 'PROCESS';
    if (scenario === 'SILENT') return;
    const destination = this.account(out.info.dest);
    const value = out.info.value.coins;
    if (scenario === 'PROCESS') {
      destination.balance += value;
      this.append(destination, out, [], genericDescription(), 0n);
      return;
    }
    const bounces = scenario === 'BOUNCE' && out.info.bounce && value > FAKE_BOUNCE_COST_NANO;
    const lt = this.nextLt();
    const back = bounces
      ? bounceOf(out, value - FAKE_BOUNCE_COST_NANO, lt + 1n, this.chainTime)
      : null;
    this.lt += 1n;
    if (back === null) destination.balance += value;
    const aborted = genericDescription({
      computeOk: false,
      aborted: true,
      bounce: back === null ? 'no-funds' : 'ok',
    });
    this.append(destination, out, back === null ? [] : [back], aborted, FAKE_TX_FEE_NANO, lt);
    if (back?.info.type !== 'internal') return;
    from.balance += back.info.value.coins;
    this.append(from, back, [], genericDescription(), 0n);
  }

  private nextLt(): bigint {
    this.lt += 10n;
    return this.lt;
  }

  private append(
    account: FakeAccount,
    inMessage: Message,
    outMessages: readonly Message[],
    description: Description,
    fee: bigint,
    lt: bigint = this.nextLt(),
  ): Transaction {
    const tx = buildTx({
      account: account.address,
      lt,
      now: this.chainTime,
      prev: account.txs.at(-1) ?? null,
      inMessage,
      outMessages,
      fee,
      description,
    });
    account.txs.push(tx);
    return tx;
  }
}
