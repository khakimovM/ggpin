import { randomUUID } from 'node:crypto';
import { ACTOR, useOpsE2e } from './ops-e2e.harness';

// wallet:adjust --key (S8-M1): the key is the AuditLog id, so a re-run after a timeout finds the
// first run instead of writing the money twice.

const t = useOpsE2e();
const WHO = ['--reason', 'support credit', '--operator', ACTOR.operator];

const freshKey = () => randomUUID().replaceAll('-', '');

function fields(out: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    out
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

describe('wallet:adjust --key (real Postgres)', () => {
  it('without --key nothing is written and a fresh key is printed; with it a re-run writes nothing again', async () => {
    const userId = await t.user();
    const noKey = await t.run(['wallet:adjust', '--user', userId, '--amount', '1500', ...WHO]);
    expect(noKey.code).toBe(1);
    expect(noKey.err.join('\n')).toMatch(/run again with --key [0-9a-f]{32}/);
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(0);

    const key = freshKey();
    const argv = ['wallet:adjust', '--user', userId, '--amount', '1500', '--key', key, ...WHO];
    const first = await t.run(argv);
    expect(fields(first.out)).toMatchObject({ applied: 'true', audit: key, balance: '1500 UZS' });
    const again = await t.run(argv);
    expect(again.code).toBe(0);
    expect(fields(again.out)).toMatchObject({ applied: 'false', audit: key, balance: '1500 UZS' });
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(1);
  });

  it('the same key with another amount or reason is IDEMPOTENCY_CONFLICT; a bad key shape is a usage error', async () => {
    const userId = await t.user();
    const key = freshKey();
    const base = ['wallet:adjust', '--user', userId, '--key', key, '--operator', ACTOR.operator];
    expect((await t.run([...base, '--amount', '1500', '--reason', 'support credit'])).code).toBe(0);
    for (const changed of [
      ['--amount', '1501', '--reason', 'support credit'],
      ['--amount', '1500', '--reason', 'another reason'],
    ]) {
      const refused = await t.run([...base, ...changed]);
      expect(refused.code).toBe(1);
      expect(refused.err[0]).toContain('IDEMPOTENCY_CONFLICT');
    }
    const badKey = await t.run([
      'wallet:adjust',
      '--user',
      userId,
      '--amount',
      '1500',
      '--key',
      'has-a-dash',
      ...WHO,
    ]);
    expect(badKey.code).toBe(2);
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(1);
  });
});
