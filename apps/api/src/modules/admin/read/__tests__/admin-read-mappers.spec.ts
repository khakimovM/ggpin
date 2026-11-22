import { RECONCILE_MISMATCH_CODES } from '@repo/shared';
import { adminRecipient } from '../../orders/admin-order-row.mapper';
import { toAdminBankMessage } from '../../payments/admin-payments.mapper';
import type { AdminBankMessageSource } from '../../payments/admin-payments-read.repository';
import { toAdminReconcileDay } from '../../payments/admin-reconcile.mapper';
import { settingItems } from '../../settings/admin-settings.service';
import { maskPhone } from '../../users/admin-user.mapper';
import { adminReadView, adminResourceId, shownIp } from '../admin-read-view';

const message: AdminBankMessageSource = {
  id: 'cm0000000000000000000000a',
  source: 'HUMO_BOT',
  parseStatus: 'PARSED',
  rejectReason: null,
  direction: 'CREDIT',
  amountTiyin: 2_012_300n,
  balanceAfterTiyin: 777_000_000n,
  last4: '1234',
  cardId: 'cm0000000000000000000000b',
  channel: 'P2P',
  tgDate: new Date('2026-11-17T10:00:00Z'),
  bankTxnAt: null,
  createdAt: new Date('2026-11-17T10:00:01Z'),
  rawText: { text: 'Popolnenie 9860123412341234' },
};

describe('admin read view (field-level permissions)', () => {
  it('OWNER sees everything, OPERATOR the phone only, SUPPORT nothing extra', () => {
    expect(adminReadView('OWNER')).toEqual({ phoneFull: true, bankMessageRaw: true, ipFull: true });
    expect(adminReadView('OPERATOR')).toEqual({
      phoneFull: true,
      bankMessageRaw: false,
      ipFull: false,
    });
    expect(adminReadView('SUPPORT')).toEqual({
      phoneFull: false,
      bankMessageRaw: false,
      ipFull: false,
    });
  });

  it('a malformed :id is NOT_FOUND, a cuid passes', () => {
    let thrown: unknown = null;
    try {
      adminResourceId('../etc');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'NOT_FOUND' });
    expect(adminResourceId('cm0000000000000000000000a')).toBe('cm0000000000000000000000a');
  });

  it('shownIp masks a full address, keeps a stored mask, drops junk', () => {
    expect(shownIp('203.0.113.45')).toBe('203.0.113.x');
    expect(shownIp('203.0.113.x')).toBe('203.0.113.x');
    expect(shownIp('2001:db8:85a3::x')).toBe('2001:db8:85a3::x');
    expect(shownIp('not an ip')).toBeNull();
    expect(shownIp('203.0.113.x; DROP')).toBeNull();
    expect(shownIp(null)).toBeNull();
  });
});

describe('maskPhone', () => {
  it.each([
    ['+998901234567', '+998 ** *** ** 67'],
    ['998 90 123 45 67', '+998 ** *** ** 67'],
    ['+79161234589', '+** *** ** 89'],
    ['12345', '**'],
  ])('%s -> %s', (phone, masked) => {
    expect(maskPhone(phone)).toBe(masked);
  });
});

describe('toAdminBankMessage (the only gate of the raw bank text)', () => {
  it('OWNER: text, balance after and channel', () => {
    const shown = toAdminBankMessage(message, adminReadView('OWNER'));
    expect(shown).toMatchObject({
      text: 'Popolnenie 9860123412341234',
      balanceAfterTiyin: '777000000',
      channel: 'P2P',
      amountTiyin: '2012300',
    });
  });

  it.each(['OPERATOR', 'SUPPORT'] as const)('%s: all three null, nothing raw anywhere', (role) => {
    const shown = toAdminBankMessage(message, adminReadView(role));
    expect(shown).toMatchObject({ text: null, balanceAfterTiyin: null, channel: null });
    expect(JSON.stringify(shown)).not.toContain('9860');
    expect(JSON.stringify(shown)).not.toContain('Popolnenie');
  });
});

describe('adminRecipient', () => {
  it('display name apart, string fields only, never a photo or a secret-looking key', () => {
    expect(
      adminRecipient({
        displayName: 'Ali',
        photoUrl: 'https://x/p.png',
        username: 'ali',
        playerId: '12345',
        token: 'abc',
        nested: { a: 1 },
      }),
    ).toEqual({ displayName: 'Ali', fields: { username: 'ali', playerId: '12345' } });
    expect(adminRecipient('junk')).toEqual({ displayName: null, fields: {} });
  });
});

describe('toAdminReconcileDay', () => {
  const row = (after: unknown) => ({
    id: 'cm0000000000000000000000c',
    targetId: '20261117',
    after,
    createdAt: new Date('2026-11-17T20:00:00Z'),
  });

  it('a clean run with an ok history scan is ok', () => {
    const day = toAdminReconcileDay(row({ count: 3, historyScan: 'ok', mismatches: {} }));
    expect(day).toMatchObject({ day: '2026-11-17', ok: true });
  });

  it('any mismatch, a failed scan or unreadable JSON is not ok', () => {
    const code = RECONCILE_MISMATCH_CODES[0];
    expect(toAdminReconcileDay(row({ historyScan: 'ok', mismatches: { [code]: 1 } })).ok).toBe(
      false,
    );
    expect(toAdminReconcileDay(row({ historyScan: 'failed', mismatches: {} })).ok).toBe(false);
    expect(toAdminReconcileDay(row('garbage')).ok).toBe(false);
  });

  it.each([-5, '3', 1.5, null, Number.NaN, {}])(
    'a present mismatch count that is not a count (%p) is not ok; it still reads as 0',
    (bad) => {
      const code = RECONCILE_MISMATCH_CODES[0];
      const day = toAdminReconcileDay(row({ historyScan: 'ok', mismatches: { [code]: bad } }));
      expect(day.ok).toBe(false);
      expect(day.mismatches[code]).toBe(0);
    },
  );

  it('a code that is simply absent is a zero, not an unreadable row', () => {
    const code = RECONCILE_MISMATCH_CODES[0];
    expect(toAdminReconcileDay(row({ historyScan: 'ok', mismatches: { [code]: 0 } })).ok).toBe(
      true,
    );
  });

  it('examples keep only resource ids, at most 20', () => {
    const code = RECONCILE_MISMATCH_CODES[0];
    const many = Array.from({ length: 30 }, (_, i) => `cm${String(i).padStart(23, '0')}`);
    const day = toAdminReconcileDay(
      row({ historyScan: 'ok', examples: { [code]: [...many, 'DROP TABLE', 7] } }),
    );
    expect(day.examples[code]).toHaveLength(20);
  });
});

describe('settingItems', () => {
  it('money and limits as strings; no secret ever (a fixed list)', () => {
    const items = settingItems({
      TOPUP_MIN_TIYIN: 1_000_000n,
      TOPUP_MAX_TIYIN: 1_000_000_000n,
      TOPUP_STEP_TIYIN: 100_000n,
      TOPUP_DAILY_MAX_TIYIN: 500_000_000n,
      TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: 100_000_000n,
      PRICE_TOLERANCE_BPS: 50,
      ADMIN_CONFIRM_THRESHOLD_TIYIN: 50_000_000n,
      ADMIN_OPERATOR_REFUND_MAX_TIYIN: 20_000_000n,
      ADMIN_OTP_DAILY_MAX: 30,
      ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: 500_000_000n,
    });
    for (const item of items) expect(typeof item.value).toBe('string');
    expect(items.find((i) => i.key === 'TOPUP_MIN_TIYIN')).toEqual({
      key: 'TOPUP_MIN_TIYIN',
      value: '1000000',
      unit: 'TIYIN',
      source: 'env',
    });
    expect(JSON.stringify(items)).not.toMatch(/SECRET|TOKEN|MNEMONIC|PASSWORD|DATABASE_URL/);
  });

  it('S6: the code quota and the daily cap of money created by hand are listed', () => {
    const items = settingItems({
      TOPUP_MIN_TIYIN: 1n,
      TOPUP_MAX_TIYIN: 2n,
      TOPUP_STEP_TIYIN: 1n,
      TOPUP_DAILY_MAX_TIYIN: 3n,
      TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: 1n,
      PRICE_TOLERANCE_BPS: 1,
      ADMIN_CONFIRM_THRESHOLD_TIYIN: 1n,
      ADMIN_OPERATOR_REFUND_MAX_TIYIN: 1n,
      ADMIN_OTP_DAILY_MAX: 30,
      ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: 500_000_000n,
    });
    expect(items).toContainEqual({
      key: 'ADMIN_OTP_DAILY_MAX',
      value: '30',
      unit: 'COUNT',
      source: 'env',
    });
    expect(items).toContainEqual({
      key: 'ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN',
      value: '500000000',
      unit: 'TIYIN',
      source: 'env',
    });
  });
});
