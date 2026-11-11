import { describe, expect, it, vi } from 'vitest';
import { NotInTransactionError, type Tx } from '../ledger/index.js';
import { lockTopupCard } from './card-lock.js';

// A stand-in for the interactive-transaction client: only $queryRaw, no $connect (the root
// client has $connect, ledger.ts explains why that is the discriminator).
function fakeTx() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return Promise.resolve([{ locked: 1 }]);
    }),
  };
  return { tx: tx as unknown as Tx, calls };
}

describe('lockTopupCard', () => {
  it('takes pg_advisory_xact_lock(hashtext(topupCardLockKey(cardId))), the key as a bound value', async () => {
    const { tx, calls } = fakeTx();
    await lockTopupCard(tx, 'cm3card0000000000000000001');
    expect(calls).toEqual([
      {
        sql: 'SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(?))',
        values: ['topup-card:cm3card0000000000000000001'],
      },
    ]);
  });

  it('refuses the root client: the lock would end with the statement', async () => {
    const { tx, calls } = fakeTx();
    const root = { ...tx, $connect: () => Promise.resolve() } as unknown as Tx;
    await expect(lockTopupCard(root, 'cm3card0000000000000000001')).rejects.toBeInstanceOf(
      NotInTransactionError,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a malformed card id before any SQL', async () => {
    const { tx, calls } = fakeTx();
    await expect(lockTopupCard(tx, "c'; --")).rejects.toThrow('malformed card id');
    expect(calls).toEqual([]);
  });
});
