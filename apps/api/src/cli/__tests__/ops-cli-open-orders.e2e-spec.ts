import { randomUUID } from 'node:crypto';
import {
  NOT_FIXTURE_ENTRY,
  orderOf,
  setOrderStatus,
} from '../../modules/admin/__tests__/admin-open-orders.fixtures';
import { WalletAdminService } from '../../modules/wallet/wallet-admin.service';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

// Phase 9 S7a, I-5: wallet:adjust prints the user's open orders with their set id and adds money
// only with --confirm-open-orders=<that set> (owner decision 2026-11-22, Q2 = B).

const t = useOpsE2e();
const WHO = ['--reason', 'held order compensation', '--operator', ACTOR.operator];

const freshKey = () => randomUUID().replaceAll('-', '');

function fields(out: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    out
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

describe('wallet:adjust with open orders (real Postgres)', () => {
  it('refused and the set printed; with the set it is written and audited; the same key replays', async () => {
    const userId = await t.user();
    const order = await orderOf(t.db(), userId, 'HELD');
    const key = freshKey();
    const argv = ['wallet:adjust', '--user', userId, '--amount', '1500', '--key', key, ...WHO];
    const refused = await t.run(argv);
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain(`openOrder=${order.id} #${String(order.number)} HELD`);
    const set = fields(refused.out)['openOrdersSet'] ?? '';
    expect(set).toMatch(/^[0-9a-f]{12}$/);
    expect(refused.err.join(' ')).toContain(`--confirm-open-orders=<openOrdersSet> --key ${key}`);
    expect(await t.db().ledgerEntry.count({ where: { userId, ...NOT_FIXTURE_ENTRY } })).toBe(0);

    const done = await t.run([...argv, `--confirm-open-orders=${set}`]);
    expect(done.code).toBe(0);
    expect(fields(done.out)).toMatchObject({
      applied: 'true',
      audit: key,
      balance: '1500 UZS',
      purchaseFrozen: 'false',
    });
    expect(fields(done.out)['confirms']).toBe(`open orders: 1 open order(s), set ${set}`);
    expect((await t.audit(key)).after).toMatchObject({ openOrders: [order.id] });

    const again = await t.run([...argv, `--confirm-open-orders=${set}`]);
    expect(fields(again.out)).toMatchObject({ applied: 'false', audit: key });
    expect(await t.db().ledgerEntry.count({ where: { userId, ...NOT_FIXTURE_ENTRY } })).toBe(1);
  });

  it('a stale set is refused; a debit is not checked; a bare or malformed flag is a usage error', async () => {
    const userId = await t.user();
    await orderOf(t.db(), userId, 'PAID');
    const base = ['wallet:adjust', '--user', userId, '--key', freshKey(), ...WHO];
    const first = await t.run([...base, '--amount', '100']);
    const stale = fields(first.out)['openOrdersSet'] ?? '';
    await orderOf(t.db(), userId, 'NEEDS_REVIEW');
    const refused = await t.run([...base, '--amount', '100', `--confirm-open-orders=${stale}`]);
    expect(refused.code).toBe(1);
    expect(fields(refused.out)['openOrdersSet']).not.toBe(stale);
    expect(await t.db().ledgerEntry.count({ where: { userId, ...NOT_FIXTURE_ENTRY } })).toBe(0);

    const debit = await t.run([...base, '--amount=-100']);
    expect(debit.code).toBe(0);
    expect(fields(debit.out)).toMatchObject({ applied: 'true', balance: '-100 UZS' });
    expect(debit.out.some((l) => l.startsWith('openOrder'))).toBe(false);

    for (const bad of [
      [...base, '--amount', '100', '--confirm-open-orders'],
      [...base.slice(0, 5), '--confirm-open-orders', ...WHO, '--amount', '100'],
      [...base, '--amount', '100', '--confirm-open-orders=ABC'],
    ]) {
      const result = await t.run(bad);
      expect(result.code).toBe(2);
      expect(result.err.join(' ')).toContain('--confirm-open-orders takes a VALUE');
    }
  });

  it('CR #2: the confirmed HELD order was auto-refunded meanwhile: refused, nothing written', async () => {
    const userId = await t.user();
    const order = await orderOf(t.db(), userId, 'HELD');
    const key = freshKey();
    const argv = ['wallet:adjust', '--user', userId, '--amount', '1500', '--key', key, ...WHO];
    const set = fields((await t.run(argv)).out)['openOrdersSet'] ?? '';
    expect(set).toMatch(/^[0-9a-f]{12}$/);
    await setOrderStatus(t.db(), order.id, 'REFUNDED'); // nothing is open any more

    const refused = await t.run([...argv, `--confirm-open-orders=${set}`]);
    expect(refused.code).toBe(1);
    expect(refused.err.join(' ')).toContain('the open orders you confirmed are closed now');
    expect(refused.err.join(' ')).toContain(
      `without --confirm-open-orders and the same --key ${key}`,
    );
    expect(await t.db().ledgerEntry.count({ where: { userId, ...NOT_FIXTURE_ENTRY } })).toBe(0);

    // The service itself, past the CLI's pre-check: the same refusal under the wallet lock.
    const wallets = t.app().get(WalletAdminService);
    await expect(
      wallets.adjust({
        userId,
        amountTiyin: 150_000n,
        reason: 'held order compensation',
        operator: ACTOR.operator,
        ip: ACTOR.ip,
        auditId: key,
        confirmOpenOrdersSet: set,
      }),
    ).rejects.toMatchObject({ details: { field: 'user', reason: 'OPEN_ORDERS' } });
    expect(await t.db().ledgerEntry.count({ where: { userId, ...NOT_FIXTURE_ENTRY } })).toBe(0);
    expect(await t.db().auditLog.count({ where: { targetId: userId } })).toBe(0);
  });
});
