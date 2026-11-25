import { printLateFacts } from '../order-late-facts';
import { proofKindOf } from '../order-view';
import { NO_SESSION, fakeApp } from './fake-cli';
import { scriptedIo } from './scripted-io';

// Phase 5 S9f CR round 3: what `order:show` prints of the late chain facts (M3 lateDestination,
// m3 SEQNO_HELD paid, M2 OTHER_TRANSFER) and that TON_NOT_SENT is not offered beside them.

const TX = 'ab'.repeat(32);
const DEST = 'cd'.repeat(32);
const T2 = 'cktransfer0000000000000002';

function printed(response: unknown): string[] {
  const terminal = scriptedIo([]);
  printLateFacts({ app: fakeApp(new Map()), io: terminal.io, session: NO_SESSION }, response);
  return terminal.out;
}

const EXPIRED_TRANSFER = {
  id: 'cktransfer0000000000000001',
  status: 'EXPIRED' as const,
  seqno: 12,
  validUntil: new Date('2026-11-17T10:05:00.000Z'),
  walletAddress: `0:${'11'.repeat(32)}`,
  toAddress: `0:${'22'.repeat(32)}`,
  amountNanoTon: 1_000_000_000n,
  extMsgHash: 'ef'.repeat(32),
  txHash: null,
  txLt: null,
  confirmedAt: null,
};

describe('order:show: late chain facts (S9f CR M2, M3, m3)', () => {
  it('M3: the lateDestination fact is one line: verdict, destination tx, order status', () => {
    const out = printed({
      ton: {
        lateDestination: {
          verdict: 'DESTINATION_ABORTED',
          destTxHash: DEST,
          orderStatus: 'PROCESSING',
        },
      },
    });
    expect(out).toEqual([
      `lateDestination=verdict=DESTINATION_ABORTED destTxHash=${DEST} orderStatus=PROCESSING`,
    ]);
    const unpaid = printed({
      ton: {
        lateDestination: { verdict: 'NOT_PAID', destTxHash: null, orderStatus: 'NEEDS_REVIEW' },
      },
    });
    expect(unpaid).toEqual([
      'lateDestination=verdict=NOT_PAID destTxHash=- orderStatus=NEEDS_REVIEW',
    ]);
    expect(printed({ ton: {} })).toEqual([]);
  });

  it('m3: SEQNO_HELD says the message PAID as signed: no refund (MANUAL FAILED would still pass)', () => {
    const out = printed({
      ton: { late: { from: 'EXPIRED', outcome: 'SEQNO_HELD', via: 'SCAN', txHash: TX, txLt: '7' } },
    });
    expect(out[0]).toBe(`late=from=EXPIRED via=SCAN outcome=SEQNO_HELD tx=${TX}@7`);
    expect(out[1]).toMatch(/^lateNote=PAID as signed on the chain .*do NOT refund it/);
    expect(out[1]).toContain('MANUAL FAILED would still pass');
  });

  it('M2: OTHER_TRANSFER names the hinted transfer and counts the message paid', () => {
    const late = {
      from: 'EXPIRED',
      outcome: 'OTHER_TRANSFER',
      via: 'HINT',
      auditId: 'audit-1',
      hintedTransferId: T2,
      txHash: TX,
      txLt: '9',
    };
    const out = printed({ ton: { late } });
    expect(out[0]).toBe(`late=from=EXPIRED via=HINT outcome=OTHER_TRANSFER tx=${TX}@9`);
    expect(out[1]).toContain(`the owner's hint for transfer ${T2} found THIS message on the chain`);
    expect(out[1]).toContain('counted as paid');
    // (c) TON_NOT_SENT is not offered for that EXPIRED transfer, and the reason is printed.
    expect(proofKindOf(EXPIRED_TRANSFER, { ton: { late } })).toMatch(
      /^none: TON_NOT_SENT is refused/,
    );
    expect(proofKindOf(EXPIRED_TRANSFER, {})).toBe('TON_NOT_SENT (--failed)');
  });

  it('any other late outcome keeps the old note', () => {
    const out = printed({ ton: { late: { from: 'EXPIRED', outcome: 'SUSPECT', via: 'SCAN' } } });
    expect(out[1]).toBe(
      'lateNote=counted NOT sent first, found on the chain later: the reconciler leaves this order to the owner',
    );
  });
});
