import { TON_BOUNCE_FEE_MAX_NANO, TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { Address, beginCell, type Cell, type Message, type Transaction } from '@ton/core';
import { buildTx, genericDescription, type PhaseOptions } from '../fake-ton-chain';
import { hashHex, rawAddress } from '../ton-address';
import {
  classifyDestination,
  classifyNotFound,
  classifyOurTx,
  type TransferFacts,
} from '../ton-classifier';
import type { OurTxFacts, OutMessageFacts, ReturnTxFacts } from '../ton-tx-facts';

// Boundaries of the pure decision (plan 6.5, D-59, D-60). classifyOurTx runs on real @ton/core
// transactions (built and serialized by the fake chain's builder): it is the D-56 (5) proof itself,
// so every branch is pinned (review m6 (a)).

const MARGIN = TON_NOT_SENT_MARGIN_MS / 1_000;
const WALLET = Address.parse(`0:${'1'.repeat(64)}`);
const DEST = Address.parse(`0:${'c'.repeat(64)}`);
const BODY = beginCell().storeUint(0x0f8a7ea5, 32).storeStringTail('order').endCell();
const AMOUNT = 1_000_000_000n;
const transfer: TransferFacts = {
  seqno: 7,
  validUntilSec: 1_800_000_000,
  toAddress: rawAddress(DEST),
  amountNano: AMOUNT,
  payloadHash: hashHex(BODY.hash()),
};

function sent(change: { to?: Address; value?: bigint; body?: Cell; lt?: bigint } = {}): Message {
  return {
    info: {
      type: 'internal',
      ihrDisabled: true,
      bounce: true,
      bounced: false,
      src: WALLET,
      dest: change.to ?? DEST,
      value: { coins: change.value ?? AMOUNT },
      ihrFee: 0n,
      forwardFee: 400_000n,
      createdLt: change.lt ?? 101n,
      createdAt: 1_800_000_010,
    },
    init: null,
    body: change.body ?? BODY,
  };
}

const external: Message = {
  info: { type: 'external-in', src: null, dest: WALLET, importFee: 0n },
  init: null,
  body: beginCell().storeUint(1, 32).endCell(),
};

function ourTx(outs: readonly Message[], phase: PhaseOptions = {}): Transaction {
  return buildTx({
    account: WALLET,
    lt: 100n,
    now: 1_800_000_010,
    prev: null,
    inMessage: external,
    outMessages: outs,
    fee: 2_000_000n,
    description: genericDescription({ totalActions: outs.length, ...phase }),
  });
}

describe('classifyNotFound: one EXPIRY observation needs the seqno unchanged AND the margin passed', () => {
  it('EXPIRY_CANDIDATE only strictly after validUntil + margin', () => {
    expect(classifyNotFound(transfer, 7, transfer.validUntilSec + MARGIN)).toEqual({
      kind: 'WAIT',
      detail: 'IN_FLIGHT',
    });
    expect(classifyNotFound(transfer, 7, transfer.validUntilSec + MARGIN + 1)).toEqual({
      kind: 'EXPIRY_CANDIDATE',
    });
  });

  it('a seqno past ours without our message is CONSUMED_UNMATCHED, at any time', () => {
    expect(classifyNotFound(transfer, 8, transfer.validUntilSec - 30)).toEqual({
      kind: 'CONSUMED_UNMATCHED',
      walletSeqno: 8,
    });
  });

  it('a lower seqno or an unreadable wallet decide nothing', () => {
    const late = transfer.validUntilSec + MARGIN + 100;
    expect(classifyNotFound(transfer, 6, late)).toEqual({ kind: 'WAIT', detail: 'SEQNO_BEHIND' });
    expect(classifyNotFound(transfer, null, late)).toEqual({
      kind: 'WAIT',
      detail: 'WALLET_UNREADABLE',
    });
  });
});

describe('classifyOurTx: exactly one message, to the payee, of the amount, with the body (m6)', () => {
  it('PAID when everything matches', () => {
    const step = classifyOurTx(transfer, ourTx([sent()]));
    expect(step.kind).toBe('PAID');
  });

  it.each([
    ['COMPUTE_FAILED', ourTx([sent()], { computeOk: false })],
    ['ACTION_FAILED', ourTx([sent()], { aborted: true })],
    ['NO_OUT_MESSAGE', ourTx([])],
    ['NO_OUT_MESSAGE', ourTx([sent()], { skippedActions: 1 })],
    ['OUT_MESSAGE_COUNT', ourTx([sent(), sent({ lt: 102n })])],
    ['OUT_MESSAGE_MISMATCH', ourTx([sent({ to: Address.parse(`0:${'d'.repeat(64)}`) })])],
    ['OUT_MESSAGE_MISMATCH', ourTx([sent({ value: AMOUNT - 1n })])],
    ['OUT_MESSAGE_MISMATCH', ourTx([sent({ value: AMOUNT + 1n })])],
    ['OUT_MESSAGE_MISMATCH', ourTx([sent({ body: beginCell().storeUint(1, 8).endCell() })])],
  ])('%s', (detail, tx) => {
    expect(classifyOurTx(transfer, tx)).toMatchObject({ kind: 'SUSPECT', detail });
  });

  it('NOT_GENERIC: a transaction that is not an ordinary one', () => {
    const tx = ourTx([sent()]);
    const storage: Transaction = {
      ...tx,
      description: {
        type: 'storage',
        storagePhase: { storageFeesCollected: 0n, statusChange: 'unchanged' },
      },
    };
    expect(classifyOurTx(transfer, storage)).toMatchObject({
      kind: 'SUSPECT',
      detail: 'NOT_GENERIC',
    });
  });
});

const out: OutMessageFacts = {
  dest: transfer.toAddress,
  valueNano: AMOUNT,
  bounce: true,
  createdLt: 101n,
  bodyHash: transfer.payloadHash,
};
const tx: OurTxFacts = {
  hash: 'a'.repeat(64),
  lt: 100n,
  utime: 1_800_000_010,
  feeNano: 2_000_000n,
  generic: true,
  computeOk: true,
  actionOk: true,
  aborted: false,
  skippedActions: 0,
  outMessages: [out],
};
const paid = { kind: 'PAID', tx, out } as const;
const returnTx = (returnedNano: bigint): ReturnTxFacts => ({
  hash: 'e'.repeat(64),
  lt: 120n,
  utime: 1_800_000_012,
  returnedNano,
  destTxHash: 'f'.repeat(64),
});
const bounce = { destTxHash: 'f'.repeat(64), createdLt: 111n, valueNano: 990_000_000n };
const bounced = (back: ReturnTxFacts | null) =>
  ({ kind: 'BOUNCED', bounce, returnTx: back }) as const;

describe('classifyDestination (D-56 (5), D-59)', () => {
  it('processed -> CONFIRMED; aborted without a bounce -> SUSPECT (never ONCHAIN_FAILED here)', () => {
    expect(classifyDestination(paid, { kind: 'PROCESSED' }, tx.utime, 20)).toEqual({
      kind: 'CONFIRMED',
      tx,
    });
    expect(classifyDestination(paid, { kind: 'ABORTED' }, tx.utime, 20)).toEqual({
      kind: 'SUSPECT',
      tx,
      detail: 'DESTINATION_ABORTED',
    });
  });

  it('not visible: the grace counts from the first successful "not found", not from our tx', () => {
    const early = { kind: 'NOT_VISIBLE', since: tx.utime } as const;
    expect(classifyDestination(paid, early, tx.utime + 19, 20)).toEqual({
      kind: 'WAIT',
      detail: 'DESTINATION_PENDING',
    });
    expect(classifyDestination(paid, early, tx.utime + 20, 20)).toEqual({ kind: 'CONFIRMED', tx });
    // The lookup failed for 100 s (errors are WAIT upstream) and answered "not found" only then.
    const late = { kind: 'NOT_VISIBLE', since: tx.utime + 100 } as const;
    expect(classifyDestination(paid, late, tx.utime + 119, 20)).toEqual({
      kind: 'WAIT',
      detail: 'DESTINATION_PENDING',
    });
    expect(classifyDestination(paid, late, tx.utime + 120, 20)).toEqual({ kind: 'CONFIRMED', tx });
  });

  it('an index answer with another transaction is a WAIT, never delivered (review M1)', () => {
    expect(classifyDestination(paid, { kind: 'MISMATCH' }, tx.utime + 10_000, 20)).toEqual({
      kind: 'WAIT',
      detail: 'DESTINATION_MISMATCH',
    });
  });

  it('BOUNCED needs the return transaction, and never more value back than was sent', () => {
    expect(classifyDestination(paid, bounced(null), tx.utime, 20)).toEqual({
      kind: 'WAIT',
      detail: 'BOUNCE_RETURN_PENDING',
    });
    const exact = returnTx(AMOUNT);
    expect(classifyDestination(paid, bounced(exact), tx.utime, 20)).toEqual({
      kind: 'BOUNCED',
      tx,
      returnTx: exact,
    });
    expect(classifyDestination(paid, bounced(returnTx(AMOUNT + 1n)), tx.utime, 20)).toEqual({
      kind: 'SUSPECT',
      tx,
      detail: 'RETURN_ABOVE_SENT',
    });
  });

  it('the floor sent - TON_BOUNCE_FEE_MAX_NANO: exactly at it and 1 above BOUNCED, 1 below SUSPECT (M2)', () => {
    const floor = AMOUNT - TON_BOUNCE_FEE_MAX_NANO;
    for (const back of [floor, floor + 1n]) {
      expect(classifyDestination(paid, bounced(returnTx(back)), tx.utime, 20)).toMatchObject({
        kind: 'BOUNCED',
      });
    }
    expect(classifyDestination(paid, bounced(returnTx(floor - 1n)), tx.utime, 20)).toEqual({
      kind: 'SUSPECT',
      tx,
      detail: 'RETURN_BELOW_FLOOR',
    });
  });
});
