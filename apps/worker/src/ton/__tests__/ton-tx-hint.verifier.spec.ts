import { Address, beginCell, type Transaction } from '@ton/core';
import { parseMajor } from '@repo/shared';
import { checkHint, signedSeqnoOf, type HintEvidence } from '../ton-tx-hint.verifier';
import { normalizedExternalHash, txRef } from '../ton-tx-scan';
import { lateChain, type LateChain, type SentPayout } from './ton-late-chain.fixtures';

// Z6 (S9f, D-64 (7), Q-7): a hint is accepted only when the primary source and EVERY witness (at
// least one) list the hinted transaction, and it is OUR wallet's external message for the
// transfer's seqno that paid exactly the signed payout to an allowed payee. Each refusal has its
// own code (the owner reads it in order:show); each check below is a mutant target.

let chain: LateChain;
let paid: SentPayout;

function evidence(overrides: Partial<HintEvidence> = {}): HintEvidence {
  return {
    wallet: chain.wallet.address,
    transfer: paid.facts,
    hint: txRef(paid.tx),
    primary: paid.tx,
    witnesses: [paid.tx],
    payAddresses: new Set([chain.payee]),
    extMsgHash: paid.signed.extMsgHash,
    orderMessages: [],
    ...overrides,
  };
}

/** The paid transaction with some facts changed; `tx.hash()` stays the listed one. */
function altered(change: Partial<Transaction>): HintEvidence {
  const tx: Transaction = { ...paid.tx, ...change };
  return evidence({ primary: tx, witnesses: [tx] });
}

const codeOf = (e: HintEvidence): string => {
  const check = checkHint(e);
  return check.kind === 'MATCH' ? 'MATCH' : check.code;
};

beforeEach(async () => {
  chain = lateChain();
  paid = await chain.pay();
});

describe('checkHint (Z6)', () => {
  it('accepts our paid transaction listed by the primary source and every witness', () => {
    const check = checkHint(evidence({ witnesses: [paid.tx, paid.tx] }));
    expect(check).toMatchObject({
      kind: 'MATCH',
      tx: { hash: txRef(paid.tx).hash, lt: paid.tx.lt },
      out: { dest: chain.payee, valueNano: paid.facts.amountNano },
    });
  });

  it('TX_NOT_FOUND: nothing listed, or another transaction at the hinted place', async () => {
    expect(codeOf(evidence({ primary: null }))).toBe('TX_NOT_FOUND');
    const other = await chain.pay();
    expect(codeOf(evidence({ primary: other.tx }))).toBe('TX_NOT_FOUND');
  });

  it('FOREIGN_ACCOUNT: a transaction of the payee, even listed at its own place', () => {
    const theirs = chain.last(Address.parseRaw(chain.payee));
    expect(codeOf(evidence({ hint: txRef(theirs), primary: theirs, witnesses: [theirs] }))).toBe(
      'FOREIGN_ACCOUNT',
    );
  });

  it('NOT_EXTERNAL: a transaction of our wallet started by an inbound transfer', () => {
    chain.gateway.receiveSpam(chain.wallet.address, 1, 5n);
    const inbound = chain.last(chain.wallet.address);
    expect(codeOf(evidence({ hint: txRef(inbound), primary: inbound, witnesses: [inbound] }))).toBe(
      'NOT_EXTERNAL',
    );
  });

  it("OTHER_TRANSFER: another transfer's message of the same order names that transfer (review F3)", () => {
    const check = checkHint(
      evidence({
        extMsgHash: 'ab'.repeat(32),
        orderMessages: [
          { transferId: 'cktransfer0000000000000009', extMsgHash: 'cd'.repeat(32) },
          { transferId: 'cktransfer0000000000000001', extMsgHash: paid.signed.extMsgHash },
        ],
      }),
    );
    expect(check).toEqual({
      kind: 'REJECT',
      code: 'OTHER_TRANSFER',
      otherTransferId: 'cktransfer0000000000000001',
    });
  });

  it('FOREIGN_MESSAGE: a message that is none of the order (mutant: own-message compare removed)', () => {
    const orderMessages = [
      { transferId: 'cktransfer0000000000000009', extMsgHash: 'cd'.repeat(32) },
    ];
    expect(codeOf(evidence({ extMsgHash: 'ab'.repeat(32), orderMessages }))).toBe(
      'FOREIGN_MESSAGE',
    );
    // Its own message passes this check even when it is also listed among the order's.
    const self = [{ transferId: 'cktransfer0000000000000001', extMsgHash: paid.signed.extMsgHash }];
    expect(codeOf(evidence({ orderMessages: self }))).toBe('MATCH');
  });

  it('BODY_UNREADABLE: our external message whose body is not a W5 signed request (F9)', () => {
    const inbound = paid.tx.inMessage;
    if (inbound === undefined || inbound === null) throw new Error('no inbound message');
    const message = { ...inbound, body: beginCell().storeUint(0x12345678, 32).endCell() };
    const e = altered({ inMessage: message });
    expect(codeOf({ ...e, extMsgHash: normalizedExternalHash(message) })).toBe('BODY_UNREADABLE');
  });

  it('TX_FAILED: aborted, compute failed or the action phase failed (F9)', () => {
    const d = paid.tx.description;
    if (d.type !== 'generic') throw new Error('not a generic transaction');
    expect(codeOf(altered({ description: { ...d, aborted: true } }))).toBe('TX_FAILED');
    const action = d.actionPhase;
    if (action === undefined || action === null) throw new Error('no action phase');
    const failedAction = { ...d, actionPhase: { ...action, success: false } };
    expect(codeOf(altered({ description: failedAction }))).toBe('TX_FAILED');
    if (d.computePhase.type !== 'vm') throw new Error('no vm compute phase');
    const failedCompute = { ...d, computePhase: { ...d.computePhase, success: false } };
    expect(codeOf(altered({ description: failedCompute }))).toBe('TX_FAILED');
  });

  it("OUT_MESSAGE_COUNT: the transaction's own count is not one (audit I-1, mutant: count check removed)", () => {
    expect(codeOf(altered({ outMessagesCount: 2 }))).toBe('OUT_MESSAGE_COUNT');
  });

  it('SEQNO_MISMATCH: signed for another seqno (mutant: seqno check removed)', () => {
    const transfer = { ...paid.facts, seqno: paid.facts.seqno + 1 };
    expect(codeOf(evidence({ transfer }))).toBe('SEQNO_MISMATCH');
  });

  it('OUT_MESSAGE_COUNT: the wallet skipped the send (balance too low)', async () => {
    chain.gateway.setBalance(chain.wallet.address, parseMajor('TON', '0.01'));
    const skipped = await chain.pay();
    const e = evidence({
      transfer: skipped.facts,
      hint: txRef(skipped.tx),
      primary: skipped.tx,
      witnesses: [skipped.tx],
      extMsgHash: skipped.signed.extMsgHash,
    });
    expect(codeOf(e)).toBe('OUT_MESSAGE_COUNT');
  });

  it('DESTINATION_MISMATCH: paid somewhere else than the payee of the transfer', () => {
    const transfer = { ...paid.facts, toAddress: `0:${'b'.repeat(64)}` };
    expect(codeOf(evidence({ transfer }))).toBe('DESTINATION_MISMATCH');
  });

  it('PAYEE_NOT_ALLOWED: the payee is no longer on FRAGMENT_PAY_ADDRESSES (mutant: check removed)', () => {
    expect(codeOf(evidence({ payAddresses: new Set() }))).toBe('PAYEE_NOT_ALLOWED');
    expect(codeOf(evidence({ payAddresses: new Set([`0:${'c'.repeat(64)}`]) }))).toBe(
      'PAYEE_NOT_ALLOWED',
    );
  });

  it('AMOUNT_MISMATCH: one nanoton off either way (mutant: check removed)', () => {
    for (const delta of [1n, -1n]) {
      const transfer = { ...paid.facts, amountNano: paid.facts.amountNano + delta };
      expect(codeOf(evidence({ transfer }))).toBe('AMOUNT_MISMATCH');
    }
  });

  it('PAYLOAD_MISMATCH: another payload (mutant: check removed)', () => {
    const transfer = { ...paid.facts, payloadHash: '0'.repeat(64) };
    expect(codeOf(evidence({ transfer }))).toBe('PAYLOAD_MISMATCH');
  });

  it('NO_WITNESS: the primary source alone proves nothing', () => {
    expect(codeOf(evidence({ witnesses: [] }))).toBe('NO_WITNESS');
  });

  it('WITNESS_MISMATCH: any witness that does not list the very transaction (mutant: "some")', async () => {
    const other = await chain.pay();
    expect(codeOf(evidence({ witnesses: [null] }))).toBe('WITNESS_MISMATCH');
    expect(codeOf(evidence({ witnesses: [paid.tx, null] }))).toBe('WITNESS_MISMATCH');
    expect(codeOf(evidence({ witnesses: [other.tx, paid.tx] }))).toBe('WITNESS_MISMATCH');
  });
});

describe('signedSeqnoOf', () => {
  it('reads the seqno of a W5 signed external body, null for anything else', () => {
    const inbound = paid.tx.inMessage;
    if (inbound === undefined || inbound === null) throw new Error('no inbound message');
    expect(signedSeqnoOf(inbound.body)).toBe(paid.facts.seqno);
    expect(signedSeqnoOf(beginCell().storeUint(0x12345678, 32).storeUint(0, 96).endCell())).toBe(
      null,
    );
    expect(signedSeqnoOf(beginCell().storeUint(0x7369676e, 32).endCell())).toBeNull();
  });
});
