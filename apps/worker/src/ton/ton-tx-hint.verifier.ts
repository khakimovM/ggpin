import type { Address, Cell, Transaction } from '@ton/core';
import { classifyOurTx, type TransferFacts } from './ton-classifier';
import type { TonTxRef } from './ton-gateway';
import { ourTxFacts, type OurTxFacts, type OutMessageFacts } from './ton-tx-facts';
import { normalizedExternalHash, sameRef, txRef } from './ton-tx-scan';

// Z6 (phase 5 S9f, D-64 (7), Q-7): the owner names the transaction that may carry a
// CONSUMED_UNMATCHED transfer's payment (`ton:hint`, AuditLog TON_TX_HINT). A hint proves nothing
// by itself: the transaction the PRIMARY source lists at the hinted (lt, hash) must be OUR wallet's,
// started by THIS transfer's own external message (its normalized hash is `extMsgHash`, review F3:
// the message of another transfer of the order is that transfer's fact, OTHER_TRANSFER, and one
// that is none of the order's is FOREIGN_MESSAGE), signed for the transfer's seqno, and it must
// have paid exactly the signed payout (one message, to the transfer's payee, which is still on
// FRAGMENT_PAY_ADDRESSES, the exact amount, the exact payload); and EVERY expiry witness (at least
// one) must list the very same transaction. A transaction's hash covers all of its content, so a
// witness that lists the same (lt, hash) has seen the same facts. Each check has its own code:
// the owner reads it in `order:show`. The destination (only a processed one is accepted) is the
// caller's next look (ton-late.service.ts). Pure: the transactions are read by the caller.

/** `signed_external` of a W5R1 request (wallet-contract-v5, `createWalletTransferV5R1` layout). */
const OP_SIGNED_EXTERNAL = 0x7369676e;
/** op:32 wallet_id:int32 valid_until:32 seqno:32 lead the signed body. */
const HEAD_BITS = 128;

export const HINT_REJECT_CODES = [
  'TX_NOT_FOUND',
  'FOREIGN_ACCOUNT',
  'NOT_EXTERNAL',
  'OTHER_TRANSFER',
  'FOREIGN_MESSAGE',
  'BODY_UNREADABLE',
  'SEQNO_MISMATCH',
  'TX_FAILED',
  'OUT_MESSAGE_COUNT',
  'DESTINATION_MISMATCH',
  'PAYEE_NOT_ALLOWED',
  'AMOUNT_MISMATCH',
  'PAYLOAD_MISMATCH',
  'NOT_PAID',
  'NO_WITNESS',
  'WITNESS_MISMATCH',
  'DESTINATION_BOUNCED',
  'DESTINATION_ABORTED',
  'RETURN_OUT_OF_RANGE',
] as const;

export type HintRejectCode = (typeof HINT_REJECT_CODES)[number];

export interface HintEvidence {
  /** Our hot wallet (the transfer's wallet). */
  readonly wallet: Address;
  readonly transfer: TransferFacts;
  /** The hinted transaction. */
  readonly hint: TonTxRef;
  /** What the primary source listed first AT the hinted (lt, hash), or null when nothing. */
  readonly primary: Transaction | null;
  /** The same from every expiry witness, in TON_EXPIRY_WITNESSES order. */
  readonly witnesses: readonly (Transaction | null)[];
  /** FRAGMENT_PAY_ADDRESSES (raw). */
  readonly payAddresses: ReadonlySet<string>;
  /** The transfer's own signed message (`TonTransfer.extMsgHash`). */
  readonly extMsgHash: string;
  /** The messages of the OTHER transfers of the transfer's order. */
  readonly orderMessages: readonly OrderMessage[];
}

export interface OrderMessage {
  readonly transferId: string;
  readonly extMsgHash: string;
}

export type HintCheck =
  | { readonly kind: 'MATCH'; readonly tx: OurTxFacts; readonly out: OutMessageFacts }
  | {
      readonly kind: 'REJECT';
      readonly code: HintRejectCode;
      /** OTHER_TRANSFER: the transfer whose message the hinted transaction carries. */
      readonly otherTransferId?: string;
    };

function reject(code: HintRejectCode): HintCheck {
  return { kind: 'REJECT', code };
}

/** The seqno a W5R1 signed external body was signed for, or null when it is not one. */
export function signedSeqnoOf(body: Cell): number | null {
  try {
    const slice = body.beginParse();
    if (slice.remainingBits < HEAD_BITS) return null;
    if (slice.loadUint(32) !== OP_SIGNED_EXTERNAL) return null;
    slice.skip(64);
    return slice.loadUint(32);
  } catch {
    return null;
  }
}

/** The account id (the address hash) a transaction of `wallet` carries. */
function accountOf(wallet: Address): bigint {
  return BigInt(`0x${wallet.hash.toString('hex')}`);
}

/** The listing answered with the hinted transaction itself. */
function isHinted(tx: Transaction | null, hint: TonTxRef): tx is Transaction {
  return tx !== null && sameRef(txRef(tx), hint);
}

export function checkHint(e: HintEvidence): HintCheck {
  const tx = e.primary;
  if (!isHinted(tx, e.hint)) return reject('TX_NOT_FOUND');
  if (tx.address !== accountOf(e.wallet)) return reject('FOREIGN_ACCOUNT');
  const inbound = tx.inMessage;
  if (inbound?.info.type !== 'external-in' || !inbound.info.dest.equals(e.wallet)) {
    return reject('NOT_EXTERNAL');
  }
  const message = normalizedExternalHash(inbound);
  if (message !== e.extMsgHash) {
    const other = e.orderMessages.find((m) => m.extMsgHash === message);
    if (other === undefined) return reject('FOREIGN_MESSAGE');
    return { kind: 'REJECT', code: 'OTHER_TRANSFER', otherTransferId: other.transferId };
  }
  const seqno = signedSeqnoOf(inbound.body);
  if (seqno === null) return reject('BODY_UNREADABLE');
  if (seqno !== e.transfer.seqno) return reject('SEQNO_MISMATCH');
  const facts = ourTxFacts(tx);
  if (!facts.generic || !facts.computeOk || facts.aborted || !facts.actionOk) {
    return reject('TX_FAILED');
  }
  // Exactly one message of any kind (audit I-1: the transaction's own count, external-out too) and
  // it is the internal one that paid; no action was skipped.
  const [out, ...rest] = facts.outMessages;
  if (tx.outMessagesCount !== 1 || out === undefined || rest.length > 0) {
    return reject('OUT_MESSAGE_COUNT');
  }
  if (facts.skippedActions > 0) return reject('OUT_MESSAGE_COUNT');
  if (out.dest !== e.transfer.toAddress) return reject('DESTINATION_MISMATCH');
  if (!e.payAddresses.has(out.dest)) return reject('PAYEE_NOT_ALLOWED');
  if (out.valueNano !== e.transfer.amountNano) return reject('AMOUNT_MISMATCH');
  if (out.bodyHash !== e.transfer.payloadHash) return reject('PAYLOAD_MISMATCH');
  // The classifier of S5 must agree too (it also counts every out message, not only internal ones).
  const paid = classifyOurTx(e.transfer, tx);
  if (paid.kind !== 'PAID') return reject('NOT_PAID');
  if (e.witnesses.length === 0) return reject('NO_WITNESS');
  if (!e.witnesses.every((witness) => isHinted(witness, e.hint))) {
    return reject('WITNESS_MISMATCH');
  }
  return { kind: 'MATCH', tx: paid.tx, out: paid.out };
}
