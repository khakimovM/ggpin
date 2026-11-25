import type { AttemptStatus, OrderStatus } from '@repo/db';
import { lateBounceMode } from '../ton-late-bounce';
import {
  HINT_TRANSIENT_LOOKS,
  LookCounter,
  hintDestination,
  isTransientRefusal,
} from '../ton-late-hint';
import { lateChain } from './ton-late-chain.fixtures';
import { classifyOurTx } from '../ton-classifier';

// The pure decisions of the S9f fix round: when a late bounce may take the order back (F1 / L-2),
// when a hint's refusal is only a lagging source (F2 / L-3), and which destination answer accepts
// a hint (F7 / L-4). Each case below is a mutant target.

describe('lateBounceMode (review F1, audit L-2)', () => {
  const live = {
    orderStatus: 'NEEDS_REVIEW' as OrderStatus,
    attemptStatus: 'UNKNOWN' as AttemptStatus,
    othersQuiet: true,
    outOfRange: false,
  };

  it('BOUNCED only for the open attempt of the one live payout of a reviewable order', () => {
    expect(lateBounceMode(live)).toBe('BOUNCED');
    for (const attemptStatus of ['SENDING', 'SENT', 'UNKNOWN'] as const) {
      expect(lateBounceMode({ ...live, attemptStatus, orderStatus: 'PROCESSING' })).toBe('BOUNCED');
    }
  });

  it('facts only for a dead attempt (the EXPIRED-then-found transfer)', () => {
    for (const attemptStatus of ['FAILED', 'CONFIRMED', null] as const) {
      expect(lateBounceMode({ ...live, attemptStatus })).toBe('FACTS');
    }
  });

  it('facts only while another transfer of the order may have paid', () => {
    expect(lateBounceMode({ ...live, othersQuiet: false })).toBe('FACTS');
  });

  it('facts only for an order the guard keeps (REFUNDED, DELIVERED, FAILED, none)', () => {
    for (const orderStatus of ['REFUNDED', 'DELIVERED', 'FAILED', null] as const) {
      expect(lateBounceMode({ ...live, orderStatus })).toBe('FACTS');
    }
  });

  it('facts only for a returned amount TON_BOUNCED does not accept (review F4)', () => {
    expect(lateBounceMode({ ...live, outOfRange: true })).toBe('FACTS');
  });
});

describe('the transient hint refusals (review F2, audit L-3)', () => {
  it(`TX_NOT_FOUND and WITNESS_MISMATCH wait ${String(HINT_TRANSIENT_LOOKS)} looks, then they are the verdict`, () => {
    for (const code of ['TX_NOT_FOUND', 'WITNESS_MISMATCH'] as const) {
      expect(isTransientRefusal(code, 1)).toBe(true);
      expect(isTransientRefusal(code, HINT_TRANSIENT_LOOKS - 1)).toBe(true);
      expect(isTransientRefusal(code, HINT_TRANSIENT_LOOKS)).toBe(false);
    }
  });

  it('a refusal the chain cannot change is the verdict at the first look', () => {
    for (const code of [
      'SEQNO_MISMATCH',
      'OTHER_TRANSFER',
      'AMOUNT_MISMATCH',
      'TX_FAILED',
    ] as const) {
      expect(isTransientRefusal(code, 1)).toBe(false);
    }
  });

  it('counts per key and drops the oldest key past its size', () => {
    const counter = new LookCounter(2);
    expect(counter.count('a')).toBe(1);
    expect(counter.count('a')).toBe(2);
    expect(counter.count('b')).toBe(1);
    expect(counter.count('c')).toBe(1);
    expect(counter.count('a')).toBe(1);
    counter.forget('c');
    expect(counter.count('c')).toBe(1);
  });
});

describe('hintDestination (review F7, audit L-4)', () => {
  it('only a destination that processed our message accepts; "not visible" waits past any grace', async () => {
    const chain = lateChain();
    const sent = await chain.pay();
    const paid = classifyOurTx(sent.facts, sent.tx);
    if (paid.kind !== 'PAID') throw new Error('the fixture payout did not pay');
    const late = sent.tx.now + 10_000;
    expect(hintDestination(paid, { kind: 'PROCESSED' }, late, 60)).toEqual({ kind: 'ACCEPT' });
    expect(hintDestination(paid, { kind: 'NOT_VISIBLE', since: sent.tx.now }, late, 60)).toEqual({
      kind: 'WAIT',
    });
    expect(hintDestination(paid, { kind: 'MISMATCH' }, late, 60)).toEqual({ kind: 'WAIT' });
    expect(hintDestination(paid, { kind: 'ABORTED' }, late, 60)).toEqual({
      kind: 'REJECT',
      code: 'DESTINATION_ABORTED',
      bounced: false,
    });
  });
});
