import type { LedgerEntry } from '@repo/db';
import { LedgerItemSchema, WalletResponseSchema } from '@repo/shared';
import { toLedgerItem } from '../entities/ledger.mapper';
import { toWalletResponse } from '../entities/wallet.mapper';

const AT = new Date('2026-11-04T10:12:00.000Z');

function row(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'cm3ledger0000000000000001',
    userId: 'user-1',
    kind: 'PURCHASE',
    amountTiyin: -550_000n,
    refType: 'ORDER',
    refId: 'cm3order00000000000000001',
    note: 'internal note',
    createdAt: AT,
    ...overrides,
  };
}

describe('toLedgerItem', () => {
  it('maps an ORDER entry: orderId set, paymentId null, money as a signed string', () => {
    expect(toLedgerItem(row())).toEqual({
      id: 'cm3ledger0000000000000001',
      kind: 'PURCHASE',
      amountTiyin: '-550000',
      createdAt: '2026-11-04T10:12:00.000Z',
      orderId: 'cm3order00000000000000001',
      paymentId: null,
    });
  });

  it('maps a PAYMENT entry: paymentId set, orderId null', () => {
    const item = toLedgerItem(
      row({ kind: 'TOPUP', amountTiyin: 2_034_100n, refType: 'PAYMENT', refId: 'cm3payment1' }),
    );
    expect(item).toMatchObject({ orderId: null, paymentId: 'cm3payment1', amountTiyin: '2034100' });
  });

  it.each(['ADMIN_ACTION', 'REFERRAL'])(
    'hides the internal reference of a %s entry (both links null)',
    (refType) => {
      const item = toLedgerItem(
        row({ kind: 'ADJUSTMENT', refType, refId: 'audit-or-referral-id' }),
      );
      expect(item.orderId).toBeNull();
      expect(item.paymentId).toBeNull();
      expect(JSON.stringify(item)).not.toContain('audit-or-referral-id');
    },
  );

  it('produces exactly the LedgerItemSchema key set (no refType, refId, note, userId)', () => {
    const item = toLedgerItem(row());
    expect(Object.keys(item).sort()).toEqual(Object.keys(LedgerItemSchema.shape).sort());
    expect(LedgerItemSchema.safeParse(item).success).toBe(true);
  });

  it('keeps a value beyond Number.MAX_SAFE_INTEGER exact', () => {
    expect(toLedgerItem(row({ amountTiyin: 9_007_199_254_740_993n })).amountTiyin).toBe(
      '9007199254740993',
    );
  });
});

describe('toWalletResponse', () => {
  it('is exactly { balanceTiyin, coins, currency } with string money, UZS and coins "0"', () => {
    const body = toWalletResponse(2_034_100n);
    expect(body).toEqual({ balanceTiyin: '2034100', coins: '0', currency: 'UZS' });
    expect(Object.keys(body).sort()).toEqual(Object.keys(WalletResponseSchema.shape).sort());
  });

  it('shows a negative balance with its sign', () => {
    const body = toWalletResponse(-550_000n);
    expect(body.balanceTiyin).toBe('-550000');
    expect(WalletResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe('toLedgerItem: a link needs a fitting kind AND ref type', () => {
  const cases: ReadonlyArray<[LedgerEntry['kind'], string, string | null, string | null]> = [
    // kind, refType, expected orderId, expected paymentId
    ['PURCHASE', 'ORDER', 'r1', null],
    ['REFUND', 'ORDER', 'r1', null],
    ['TOPUP', 'PAYMENT', null, 'r1'],
    ['TOPUP_REVERSAL', 'PAYMENT', null, 'r1'],
    // right ref type, wrong kind: the id is not exposed
    ['ADJUSTMENT', 'ORDER', null, null],
    ['REFERRAL_BONUS', 'ORDER', null, null],
    ['REFERRAL_BONUS_REVERSAL', 'ORDER', null, null],
    ['TOPUP', 'ORDER', null, null],
    ['PURCHASE', 'PAYMENT', null, null],
    ['ADJUSTMENT', 'PAYMENT', null, null],
    ['REFERRAL_BONUS', 'PAYMENT', null, null],
    ['REFUND', 'PAYMENT', null, null],
    // right kind, wrong ref type
    ['PURCHASE', 'ADMIN_ACTION', null, null],
    ['REFUND', 'ADMIN_ACTION', null, null],
    ['REFUND', 'REFERRAL', null, null],
    ['TOPUP', 'ADMIN_ACTION', null, null],
    ['TOPUP_REVERSAL', 'REFERRAL', null, null],
    ['ADJUSTMENT', 'ADMIN_ACTION', null, null],
    ['REFERRAL_BONUS', 'REFERRAL', null, null],
    ['REFERRAL_BONUS_REVERSAL', 'ADMIN_ACTION', null, null],
  ];

  it.each(cases)('%s via %s -> orderId %s, paymentId %s', (kind, refType, orderId, paymentId) => {
    const item = toLedgerItem(row({ kind, refType, refId: 'r1' }));
    expect(item.orderId).toBe(orderId);
    expect(item.paymentId).toBe(paymentId);
  });

  it('covers every ledger kind at least once as a positive or negative case', () => {
    const covered = new Set(cases.map(([kind]) => kind));
    expect([...covered].sort()).toEqual(
      [
        'ADJUSTMENT',
        'PURCHASE',
        'REFERRAL_BONUS',
        'REFERRAL_BONUS_REVERSAL',
        'REFUND',
        'TOPUP',
        'TOPUP_REVERSAL',
      ].sort(),
    );
  });
});
