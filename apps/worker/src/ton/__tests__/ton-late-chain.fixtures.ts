import { randomBytes } from 'node:crypto';
import { parseMajor } from '@repo/shared';
import { Address, beginCell, type Transaction } from '@ton/core';
import { FakeTonGateway } from '../fake-ton.gateway';
import type { TransferFacts } from '../ton-classifier';
import { dryRunTonWallet, type SignedTransfer, type TonWallet } from '../ton-wallet';

// An in-memory chain for the pure late-fact checks (ton-tx-hint.verifier.ts, ton-onchain-failed.ts):
// one hot wallet, one payee, payouts signed by the wallet and sent through the fake network. No
// database, no Redis; nothing leaves the process.

export const ONE_TON = parseMajor('TON', '1');

export interface SentPayout {
  readonly signed: SignedTransfer;
  readonly facts: TransferFacts;
  /** Our wallet's transaction for it (null when the chain dropped the message). */
  readonly tx: Transaction;
}

export interface LateChain {
  readonly wallet: TonWallet;
  readonly gateway: FakeTonGateway;
  readonly payee: string;
  /** Signs a payout of ONE_TON to the payee for the wallet's current seqno, sends it, returns it. */
  pay(overrides?: { readonly amountNano?: bigint; readonly to?: string }): Promise<SentPayout>;
  /** The newest transaction of an account. */
  last(address: Address): Transaction;
}

export function lateChain(): LateChain {
  const wallet = dryRunTonWallet('testnet');
  const gateway = new FakeTonGateway({ production: false, dryRun: true });
  gateway.registerWallet(wallet, parseMajor('TON', '100'));
  gateway.setChainTime(Math.floor(Date.now() / 1_000), true);
  const payee = new Address(0, randomBytes(32)).toRawString();
  let seqno = 0;

  function last(address: Address): Transaction {
    const tx = gateway.transactionsOf(address).at(-1);
    if (tx === undefined) throw new Error('no transaction on the fake chain');
    return tx;
  }

  return {
    wallet,
    gateway,
    payee,
    last,
    async pay(overrides = {}) {
      const to = overrides.to ?? payee;
      const amountNano = overrides.amountNano ?? ONE_TON;
      const validUntilSec = Math.floor(Date.now() / 1_000) + 600;
      const body = beginCell().storeUint(0, 32).storeStringTail('order payload').endCell();
      const signed = wallet.sign({
        seqno,
        validUntilSec,
        to: Address.parseRaw(to),
        amountNano,
        body,
        bounce: true,
        deploy: false,
      });
      const before = gateway.transactionsOf(wallet.address).length;
      await gateway.sendBoc(signed.boc);
      if (gateway.transactionsOf(wallet.address).length === before) {
        throw new Error('the fake chain did not take the payout');
      }
      const facts: TransferFacts = {
        seqno,
        validUntilSec,
        toAddress: to,
        amountNano,
        payloadHash: signed.payloadHash,
      };
      seqno += 1;
      return { signed, facts, tx: last(wallet.address) };
    },
  };
}
