import type { OrderAttemptRow } from '../../modules/orders/admin/order-admin.repository';
import type { OrderShow } from '../../modules/orders/admin/order-admin-read.service';
import { deadEndOf } from '../order-dead-end';
import { printShow } from '../order-view';
import { NO_SESSION, fakeApp } from './fake-cli';
import { scriptedIo } from './scripted-io';

// Phase 5 S9f, owner 2026-11-18 (option B): the dead end stays NEEDS_REVIEW until A1 (before
// mainnet); `order:show` says so in one line, so nobody tries a proof the helpers must refuse.

type TransferStatus = NonNullable<OrderAttemptRow['tonTransfer']>['status'];
const SEQNO_HELD = { from: 'EXPIRED', outcome: 'SEQNO_HELD', via: 'SCAN' };
const LATE_CONFIRMED = { from: 'EXPIRED', outcome: 'CONFIRMED', via: 'SCAN' };

function attempt(n: number, transfer: TransferStatus, late: object | null): OrderAttemptRow {
  return {
    id: `ckattempt000000000000000${String(n)}`,
    attemptNo: n,
    adapter: 'fragment',
    status: n === 1 ? 'FAILED' : 'UNKNOWN',
    externalRef: null,
    error: null,
    response: late === null ? {} : { ton: { late } },
    createdAt: new Date('2026-11-17T10:00:00.000Z'),
    tonTransfer: {
      id: `cktransfer00000000000000${String(n)}`,
      status: transfer,
      seqno: 12,
      validUntil: new Date('2026-11-17T10:05:00.000Z'),
      walletAddress: `0:${'11'.repeat(32)}`,
      toAddress: `0:${'22'.repeat(32)}`,
      amountNanoTon: 1_000_000_000n,
      extMsgHash: `${String(n)}`.repeat(64),
      txHash: null,
      txLt: null,
      confirmedAt: null,
    },
  };
}

const T1 = 'cktransfer000000000000001';
const T2 = 'cktransfer000000000000002';

describe('order:show: the dead end (S9f, option B)', () => {
  it.each([
    ['EXPIRED + SEQNO_HELD', 'EXPIRED', SEQNO_HELD],
    ['CONFIRMED late', 'CONFIRMED', LATE_CONFIRMED],
  ] as const)('T1 %s beside T2 CONSUMED_UNMATCHED: one line, no way out', (_, status, late) => {
    const line = deadEndOf('NEEDS_REVIEW', [
      attempt(1, status, late),
      attempt(2, 'CONSUMED_UNMATCHED', null),
    ]);
    expect(line).toBe(
      `no proof can close this order: transfer ${T1} carries a late chain fact while ${T2} is CONSUMED_UNMATCHED; it stays NEEDS_REVIEW until A1 (before mainnet)`,
    );
  });

  it('not a dead end: no late fact, no CU beside it, or the order is not in review', () => {
    const cuBesideClean = [attempt(1, 'EXPIRED', null), attempt(2, 'CONSUMED_UNMATCHED', null)];
    expect(deadEndOf('NEEDS_REVIEW', cuBesideClean)).toBeNull();
    // MANUAL FAILED is the way out there (every transfer EXPIRED).
    const lateBesideExpired = [attempt(1, 'EXPIRED', SEQNO_HELD), attempt(2, 'EXPIRED', null)];
    expect(deadEndOf('NEEDS_REVIEW', lateBesideExpired)).toBeNull();
    const dead = [attempt(1, 'EXPIRED', SEQNO_HELD), attempt(2, 'CONSUMED_UNMATCHED', null)];
    for (const status of ['HELD', 'DELIVERED', 'REFUNDED', 'PROCESSING']) {
      expect(deadEndOf(status, dead)).toBeNull();
    }
  });

  // CR M1: T1 paid late, attempt 2 stopped by the M-1 gate (no transfer, no reference): no proof binds.
  const bare = (status: OrderAttemptRow['status']): OrderAttemptRow => ({
    ...attempt(2, 'EXPIRED', null),
    status,
    tonTransfer: null,
  });
  const OTHER = { from: 'EXPIRED', outcome: 'OTHER_TRANSFER', via: 'HINT', hintedTransferId: T2 };
  const A2 = bare('UNKNOWN').id;

  it.each([
    ['CONFIRMED late', 'CONFIRMED', LATE_CONFIRMED],
    ['EXPIRED + SEQNO_HELD', 'EXPIRED', SEQNO_HELD],
    ['EXPIRED + OTHER_TRANSFER', 'EXPIRED', OTHER],
  ] as const)('shape 2: T1 %s beside a bare open attempt: one line (CR M1)', (_, status, late) => {
    const line = deadEndOf('NEEDS_REVIEW', [attempt(1, status, late), bare('UNKNOWN')]);
    expect(line).toBe(
      `no proof can close this order: transfer ${T1} was found paid on the chain late while attempt ${A2} has no transfer and no reference; it stays NEEDS_REVIEW until A1 (before mainnet)`,
    );
  });

  it('shape 2 controls: a closable order prints nothing', () => {
    // SUSPECT paid nothing as signed: MANUAL FAILED is the honest way out.
    const suspect = { from: 'EXPIRED', outcome: 'SUSPECT', via: 'SCAN' };
    expect(deadEndOf('NEEDS_REVIEW', [attempt(1, 'EXPIRED', suspect), bare('UNKNOWN')])).toBeNull();
    // The bare attempt is closed (FAILED by a hold) or carries a reference.
    expect(
      deadEndOf('NEEDS_REVIEW', [attempt(1, 'CONFIRMED', LATE_CONFIRMED), bare('FAILED')]),
    ).toBeNull();
    const withRef = { ...bare('UNKNOWN'), externalRef: 'req-1' };
    expect(
      deadEndOf('NEEDS_REVIEW', [attempt(1, 'CONFIRMED', LATE_CONFIRMED), withRef]),
    ).toBeNull();
    // No late fact on T1 (a plain EXPIRED): TON_NOT_SENT / MANUAL FAILED close it.
    expect(deadEndOf('NEEDS_REVIEW', [attempt(1, 'EXPIRED', null), bare('UNKNOWN')])).toBeNull();
    // The paid-late transfer's own attempt is open (no bare one): the owner's TON_TX closes it.
    expect(
      deadEndOf('NEEDS_REVIEW', [
        { ...attempt(1, 'CONFIRMED', LATE_CONFIRMED), status: 'UNKNOWN' },
      ]),
    ).toBeNull();
    expect(
      deadEndOf('HELD', [attempt(1, 'CONFIRMED', LATE_CONFIRMED), bare('UNKNOWN')]),
    ).toBeNull();
  });

  it('printShow prints it once, right after the order line', () => {
    const show = (attempts: OrderAttemptRow[]): OrderShow => ({
      order: {
        id: 'ckorder0000000000000000001',
        number: 1042,
        status: 'NEEDS_REVIEW',
        statusReason: 'ADAPTER_ERROR',
        priceTiyin: 5_000_000n,
        discountTiyin: 0n,
        quantity: 50,
        createdAt: new Date('2026-11-17T09:59:00.000Z'),
        product: { slug: 'telegram-stars', deliveryType: 'TG_USERNAME' },
        userId: 'ckuser00000000000000000001',
        costCurrency: 'TON',
        deliveredAt: null,
        updatedAt: new Date('2026-11-17T10:10:00.000Z'),
        events: [],
        attempts,
      },
      ledger: [],
      audits: [],
    });
    const print = (attempts: OrderAttemptRow[]) => {
      const terminal = scriptedIo([]);
      printShow({ app: fakeApp(new Map()), io: terminal.io, session: NO_SESSION }, show(attempts));
      return terminal.out;
    };
    const out = print([attempt(1, 'EXPIRED', SEQNO_HELD), attempt(2, 'CONSUMED_UNMATCHED', null)]);
    const lines = out.filter((line) => line.startsWith('deadEnd='));
    expect(lines).toHaveLength(1);
    expect(out.indexOf(lines[0] ?? '')).toBe(out.indexOf('deliveredAt=-') + 1);
    expect(lines[0]).toContain('it stays NEEDS_REVIEW until A1 (before mainnet)');
    const clean = print([attempt(1, 'EXPIRED', null), attempt(2, 'CONSUMED_UNMATCHED', null)]);
    expect(clean.some((line) => line.startsWith('deadEnd='))).toBe(false);
    const second = print([attempt(1, 'CONFIRMED', LATE_CONFIRMED), bare('UNKNOWN')]);
    const shape2 = second.filter((line) => line.startsWith('deadEnd='));
    expect(shape2).toHaveLength(1);
    expect(shape2[0]).toContain(`attempt ${A2} has no transfer and no reference`);
  });
});
