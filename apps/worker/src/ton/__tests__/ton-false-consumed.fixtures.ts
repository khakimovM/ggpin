import { Address, type Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import type { FakeDestinationScenario } from '../fake-ton-state';
import type { TonAccountState, TxPage } from '../ton-gateway';
import { payRequest, rowsOf } from './ton-e2e.fixtures';
import { WALLET_BALANCE, type TonE2e } from './ton-e2e.harness';
import { hex } from './ton-late.e2e-kit';

// The way a CONSUMED_UNMATCHED transfer's OWN message can be on the chain (the Z6 hint's case,
// review F3): the node the S5 scan read was on another history (a fork) in which some other
// message of our wallet took the seqno; the scan's hash-chain checks hold inside that history, so
// it decided CONSUMED_UNMATCHED. The chain kept our message. The owner finds it in an explorer and
// names it (`ton:hint`). An index hole cannot do this (the scan verifies every link, ton-tx-scan.ts:
// FORK / PASS), so the device is a whole second history. Test only; nothing leaves the process.

const OPTIONS = { production: false, dryRun: true } as const;

/** The chain; while `fork` is set every read answers from that other history instead. */
export class ForkedChainGateway extends FakeTonGateway {
  fork: FakeTonGateway | null = null;

  override getAccountState(address: Address): Promise<TonAccountState> {
    return this.fork === null ? super.getAccountState(address) : this.fork.getAccountState(address);
  }

  override getBalance(address: Address): Promise<bigint> {
    return this.fork === null ? super.getBalance(address) : this.fork.getBalance(address);
  }

  override getTransactions(address: Address, page: TxPage): Promise<readonly Transaction[]> {
    return this.fork === null
      ? super.getTransactions(address, page)
      : this.fork.getTransactions(address, page);
  }

  override findResultTx(
    source: Address,
    destination: Address,
    createdLt: bigint,
  ): Promise<Transaction | null> {
    return this.fork === null
      ? super.findResultTx(source, destination, createdLt)
      : this.fork.findResultTx(source, destination, createdLt);
  }
}

const isExternal = (tx: Transaction): boolean => tx.inMessage?.info.type === 'external-in';

/**
 * A CONSUMED_UNMATCHED transfer whose own message is on the chain (S5 read a fork in which a twin
 * of the same payout took the seqno). Its own worker process (wallet, chain, TON module); the
 * returned `fork` can be put back in front (`gateway.fork = fork`) to hide the chain again.
 */
export async function falselyConsumed(t: TonE2e, destination: FakeDestinationScenario = 'PROCESS') {
  const wallet = t.newWallet();
  const gateway = new ForkedChainGateway(OPTIONS);
  const fork = new FakeTonGateway(OPTIONS);
  gateway.registerWallet(wallet, WALLET_BALANCE);
  fork.registerWallet(wallet, WALLET_BALANCE);
  fork.setChainTime(gateway.chainTime, true);
  const ton = await t.boot({ wallet, gateway });
  const fixture = await t.order();
  const request = payRequest(fixture);
  const to = Address.parseRaw(request.toAddress);
  gateway.destination(to, destination);
  ton.hooks.afterStoredFn = async (transferId) => {
    const row = await t.db.tonTransfer.findUniqueOrThrow({ where: { id: transferId } });
    const twin = wallet.sign({
      seqno: row.seqno,
      validUntilSec: Math.floor(row.validUntil.getTime() / 1_000) - 1,
      to,
      amountNano: request.amountNano,
      body: request.payload,
      bounce: true,
      deploy: false,
    });
    await fork.sendBoc(twin.boc);
    gateway.fork = fork;
  };
  const result = await ton.sender.pay(request);
  ton.hooks.afterStoredFn = () => Promise.resolve();
  if (result.status !== 'REVIEW' || result.transferStatus !== 'CONSUMED_UNMATCHED') {
    throw new Error(`expected CONSUMED_UNMATCHED, got ${JSON.stringify(result)}`);
  }
  gateway.fork = null;
  const ours = gateway.transactionsOf(wallet.address).filter(isExternal).at(-1);
  const rows = await rowsOf(t.db, fixture);
  return {
    fixture,
    request,
    gateway,
    fork,
    ton,
    transferId: rows.transfer?.id ?? '',
    ref: { txHash: hex(ours) ?? '', lt: String(ours?.lt) },
  };
}
