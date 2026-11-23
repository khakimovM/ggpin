import {
  AdminAdjustWalletBodySchema,
  AdminConfirmationBodySchema,
  type AdminAdjustPreview,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  adjustBody,
  adjustConfirmation,
  setsConfirmed,
  signedAmount,
  type AdjustInput,
} from '../adjust-model';

const preview: AdminAdjustPreview = {
  balanceTiyin: '8540000',
  newBalanceTiyin: '23540000',
  otpRequired: true,
  otpReason: 'CREDIT',
  recentAutoTopups: [],
  confirmOverrideSet: 'a1b2c3d4e5f6',
  openOrders: [],
  confirmOpenOrdersSet: 'f6e5d4c3b2a1',
  manualCreditToday: { usedTiyin: '0', capTiyin: '500000000' },
};

const input: AdjustInput = {
  userId: 'mkuser000001',
  amountTiyin: '15000000',
  preview,
  recentConfirmed: true,
  openOrdersConfirmed: true,
  idempotencyKey: 'key_0000000001',
  confirmAmountTiyin: '15000000',
};

describe('signedAmount', () => {
  it('puts the chosen sign on a magnitude typed without one', () => {
    expect(signedAmount('+', '150 000')).toBe('15000000');
    expect(signedAmount('-', '1 500,50')).toBe('-150050');
    expect(signedAmount('-', '0')).toBeNull();
    expect(signedAmount('+', '-5')).toBeNull();
  });
});

describe('adjust builder (one source for the code and the action)', () => {
  it('the confirmation carries every bound field of the action body', () => {
    const confirmation = AdminConfirmationBodySchema.parse(adjustConfirmation(input));
    const body = AdminAdjustWalletBodySchema.parse(
      adjustBody(input, {
        reason: 'Kompensatsiya uchun',
        otp: { challengeId: 'c'.repeat(32), code: '123456' },
      }),
    );
    expect(confirmation).toMatchObject({
      action: 'users.adjustWallet',
      targetId: input.userId,
      amountTiyin: body.confirmAmountTiyin,
      confirmOverrideSet: body.confirmOverrideSet,
      confirmOpenOrdersSet: body.confirmOpenOrdersSet,
      idempotencyKey: input.idempotencyKey,
    });
    expect(body.amountTiyin).toBe('15000000');
  });

  it('leaves out a set that was not ticked, and sends no code fields without a code', () => {
    const plain = { ...input, recentConfirmed: false, confirmAmountTiyin: null };
    expect(setsConfirmed(plain)).toBe(false);
    const body = adjustBody(plain, { reason: 'Kompensatsiya uchun', otp: null });
    expect(body).not.toHaveProperty('confirmOverrideSet');
    expect(body).not.toHaveProperty('otp');
    expect(body).not.toHaveProperty('confirmAmountTiyin');
  });

  it('needs every set the preview shows, and none it does not', () => {
    expect(setsConfirmed(input)).toBe(true);
    expect(setsConfirmed({ ...input, openOrdersConfirmed: false })).toBe(false);
    const none = { ...preview, confirmOverrideSet: null, confirmOpenOrdersSet: null };
    expect(
      setsConfirmed({ preview: none, recentConfirmed: false, openOrdersConfirmed: false }),
    ).toBe(true);
  });
});
