// Phase 9 S7a: the adjust-preview shapes and the I-5 open-orders set (docs/04 «Foydalanuvchilar»,
// owner decision 2026-11-22).
import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '../order-state';
import {
  ADMIN_OPEN_ORDER_STATUSES,
  AdminAdjustPreviewQuerySchema,
  AdminAdjustPreviewResponseSchema,
  AdminAdjustWalletBodySchema,
  AdminConfirmationBodySchema,
} from './index';

const SET = '0123456789ab';
const ID = 'cmuser0000000000000000001';

const preview = {
  balanceTiyin: '-500',
  newBalanceTiyin: '99500',
  otpRequired: true,
  otpReason: 'CREDIT',
  recentAutoTopups: [
    { paymentId: ID, amountTiyin: '100', confirmedAt: '2026-11-22T10:00:00.000Z' },
  ],
  confirmOverrideSet: SET,
  openOrders: [
    {
      id: ID,
      number: 7,
      status: 'HELD',
      priceTiyin: '1600000',
      createdAt: '2026-11-22T09:00:00.000Z',
    },
  ],
  confirmOpenOrdersSet: SET,
  manualCreditToday: { usedTiyin: '0', capTiyin: '500000000' },
};

describe('open orders (I-5)', () => {
  it('are exactly the statuses that are neither delivered nor finished with the money back', () => {
    const closed = ['DELIVERED', 'FAILED', 'CANCELLED', 'REFUNDED'];
    expect([...ADMIN_OPEN_ORDER_STATUSES]).toEqual(
      ORDER_STATUSES.filter((s) => !closed.includes(s)),
    );
  });
});

describe('adjust-preview query', () => {
  const ok = (amountTiyin: unknown) =>
    AdminAdjustPreviewQuerySchema.safeParse({ amountTiyin }).success;

  it('takes a signed non-zero amount within the max, as a query string', () => {
    expect(ok('150000')).toBe(true);
    expect(ok('-150000')).toBe(true);
    expect(ok('100000000000')).toBe(true);
    for (const bad of ['0', '-0', '1.5', '+5', '05', '100000000001', '', 5]) {
      expect(ok(bad), String(bad)).toBe(false);
    }
    expect(AdminAdjustPreviewQuerySchema.safeParse({}).success).toBe(false);
    expect(AdminAdjustPreviewQuerySchema.safeParse({ amountTiyin: '1', x: '1' }).success).toBe(
      false,
    );
  });
});

describe('adjust-preview response', () => {
  it('parses the contract shape; sets and the reason may be null', () => {
    expect(AdminAdjustPreviewResponseSchema.safeParse(preview).success).toBe(true);
    const none = {
      ...preview,
      otpRequired: false,
      otpReason: null,
      recentAutoTopups: [],
      confirmOverrideSet: null,
      openOrders: [],
      confirmOpenOrdersSet: null,
    };
    expect(AdminAdjustPreviewResponseSchema.safeParse(none).success).toBe(true);
  });

  it('refuses a closed order, a numeric amount, an unknown reason and a malformed set', () => {
    const order = preview.openOrders[0];
    const bad = [
      { ...preview, openOrders: [{ ...order, status: 'DELIVERED' }] },
      { ...preview, openOrders: [{ ...order, priceTiyin: 1600000 }] },
      { ...preview, otpReason: 'ALWAYS' },
      { ...preview, confirmOpenOrdersSet: 'ABCDEF012345' },
      { ...preview, confirmOverrideSet: '0123456789a' },
      { ...preview, extra: true },
    ];
    for (const value of bad) {
      expect(AdminAdjustPreviewResponseSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('confirmOpenOrdersSet in the action and in its code', () => {
  const body = { amountTiyin: '5000', reason: 'Kompensatsiya, HELD buyurtma tekshirildi' };

  it('is optional, 12 lower-case hex, in both bodies', () => {
    expect(
      AdminAdjustWalletBodySchema.safeParse({ ...body, confirmOpenOrdersSet: SET }).success,
    ).toBe(true);
    expect(AdminAdjustWalletBodySchema.safeParse(body).success).toBe(true);
    expect(
      AdminAdjustWalletBodySchema.safeParse({ ...body, confirmOpenOrdersSet: 'xyz' }).success,
    ).toBe(false);
    const code = {
      action: 'users.adjustWallet',
      targetId: ID,
      amountTiyin: '5000',
      idempotencyKey: 'key-00000001',
    };
    expect(
      AdminConfirmationBodySchema.safeParse({ ...code, confirmOpenOrdersSet: SET }).success,
    ).toBe(true);
    expect(
      AdminConfirmationBodySchema.safeParse({ ...code, confirmOpenOrdersSet: SET.toUpperCase() })
        .success,
    ).toBe(false);
  });
});
