import { adjustBindingFlags } from '../../../wallet/wallet-admin.input';
import { openOrdersFlag, openOrdersSetHash } from '../../../wallet/wallet-open-orders';
import { adminConfirmFlagLabels } from '../admin-otp-flags';

// Phase 9 S7a: the open-orders flag the code is bound to (I-5) is shown in the admin's language,
// never as the raw server string.

const body = {
  action: 'users.adjustWallet',
  targetId: 'u1',
  amountTiyin: '500000',
  idempotencyKey: 'key-00000001',
} as const;
const OPEN = [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }];
const set = openOrdersSetHash(OPEN);

describe('adminConfirmFlagLabels: open orders (I-5)', () => {
  it('reads the flag into words with its count and set, in uz and ru', () => {
    const flag = openOrdersFlag(OPEN);
    expect(adminConfirmFlagLabels('uz', body, [flag])).toEqual([
      `Ochiq buyurtmalar bor: 3 ta, to‘plam ${set}`,
    ]);
    expect(adminConfirmFlagLabels('ru', body, [flag])).toEqual([
      `Есть открытые заказы: 3, набор ${set}`,
    ]);
  });

  it('shows each part of a joined flag (override and open orders together)', () => {
    const recent = [{ id: 'p1', amountTiyin: 100n, confirmedAt: null }];
    const labels = adminConfirmFlagLabels('uz', body, [adjustBindingFlags(recent, true, OPEN)]);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('avtomatik to‘ldirishlar soni 1');
    expect(labels[1]).toBe(`Ochiq buyurtmalar bor: 3 ta, to‘plam ${set}`);
  });

  it('a near-miss string is shown raw, never hidden', () => {
    const odd = `open orders: 3 orders, set ${set}`;
    expect(adminConfirmFlagLabels('uz', body, [odd])).toEqual([odd]);
  });
});
