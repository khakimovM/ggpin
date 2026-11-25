import type { Address, Message, Transaction } from '@ton/core';
import { hashHex, rawAddress } from './ton-address';
import type { TonTxRef } from './ton-gateway';
import { txRef } from './ton-tx-scan';

// Facts read from @ton/core `Transaction` objects (types: TransactionDescriptionGeneric with its
// compute / action / bounce phases, CommonMessageInfoInternal). Only fields those types define are
// used; how a REAL Fragment payment or bounce fills them is "S9 fixture bilan aniqlanadi" (plan
// S1 criteria: the bounce classifier and TON_BOUNCE_FEE_MAX_NANO are settled with recorded data).

export interface OutMessageFacts {
  readonly dest: string;
  readonly valueNano: bigint;
  readonly bounce: boolean;
  readonly createdLt: bigint;
  readonly bodyHash: string;
}

export interface OurTxFacts {
  readonly hash: string;
  readonly lt: bigint;
  readonly utime: number;
  readonly feeNano: bigint;
  readonly generic: boolean;
  readonly computeOk: boolean;
  readonly actionOk: boolean;
  readonly aborted: boolean;
  readonly skippedActions: number;
  readonly outMessages: readonly OutMessageFacts[];
}

function internalOut(message: Message): OutMessageFacts | null {
  if (message.info.type !== 'internal') return null;
  return {
    dest: rawAddress(message.info.dest),
    valueNano: message.info.value.coins,
    bounce: message.info.bounce,
    createdLt: message.info.createdLt,
    bodyHash: hashHex(message.body.hash()),
  };
}

export function ourTxFacts(tx: Transaction): OurTxFacts {
  const d = tx.description;
  const generic = d.type === 'generic' ? d : null;
  const compute = generic?.computePhase;
  const action = generic?.actionPhase ?? null;
  const outMessages: OutMessageFacts[] = [];
  for (const message of tx.outMessages.values()) {
    const out = internalOut(message);
    if (out !== null) outMessages.push(out);
  }
  return {
    hash: hashHex(tx.hash()),
    lt: tx.lt,
    utime: tx.now,
    feeNano: tx.totalFees.coins,
    generic: generic !== null,
    computeOk: compute?.type === 'vm' && compute.success,
    actionOk: action !== null && action.success,
    aborted: generic?.aborted ?? true,
    skippedActions: action?.skippedActions ?? 0,
    outMessages,
  };
}

/** The destination's transaction is the one that processed our message `out`. */
export function processedOurMessage(
  destTx: Transaction,
  wallet: Address,
  out: OutMessageFacts,
): boolean {
  const info = destTx.inMessage?.info;
  return (
    info?.type === 'internal' &&
    info.src.equals(wallet) &&
    rawAddress(info.dest) === out.dest &&
    info.createdLt === out.createdLt
  );
}

export interface BounceMessageFacts {
  readonly destTxHash: string;
  readonly createdLt: bigint;
  readonly valueNano: bigint;
}

/**
 * The destination aborted our message AND its bounce phase sent the value back (generic
 * description, `aborted`, `bouncePhase.type === 'ok'`), with the bounced message to our wallet.
 * Null when the destination did not bounce (processed, or aborted without a bounce).
 */
export function bounceSentBack(destTx: Transaction, wallet: Address): BounceMessageFacts | null {
  const d = destTx.description;
  if (d.type !== 'generic' || !d.aborted || d.bouncePhase?.type !== 'ok') return null;
  for (const message of destTx.outMessages.values()) {
    const info = message.info;
    if (info.type === 'internal' && info.bounced && info.dest.equals(wallet)) {
      return {
        destTxHash: hashHex(destTx.hash()),
        createdLt: info.createdLt,
        valueNano: info.value.coins,
      };
    }
  }
  return null;
}

/** The destination aborted without sending the value back: it never processed the payment. */
export function abortedWithoutBounce(destTx: Transaction, wallet: Address): boolean {
  const d = destTx.description;
  return d.type === 'generic' && d.aborted && bounceSentBack(destTx, wallet) === null;
}

export interface ReturnTxFacts extends TonTxRef {
  readonly utime: number;
  readonly returnedNano: bigint;
  readonly destTxHash: string;
}

/** Our wallet's transaction that received exactly that bounced message. */
export function returnTxOf(
  tx: Transaction,
  wallet: Address,
  destination: string,
  bounce: BounceMessageFacts,
): ReturnTxFacts | null {
  const info = tx.inMessage?.info;
  if (info?.type !== 'internal' || !info.bounced) return null;
  if (!info.dest.equals(wallet) || rawAddress(info.src) !== destination) return null;
  if (info.createdLt !== bounce.createdLt) return null;
  return {
    ...txRef(tx),
    utime: tx.now,
    returnedNano: info.value.coins,
    destTxHash: bounce.destTxHash,
  };
}
