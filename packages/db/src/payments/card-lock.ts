import { topupCardLockKey } from '@repo/shared';
import { assertInTransaction, type Tx } from '../ledger/ledger.js';

/**
 * The per-card advisory lock (docs/05 §3), in ONE place for the API (allocation, card commands)
 * and the worker (crediting, card status). Held until the surrounding transaction ends; never
 * take two in one transaction. Throws `NotInTransactionError` for the root client: there the
 * lock would end with the statement and protect nothing. `SELECT 1 ... FROM`: Prisma cannot
 * deserialise the `void` the lock function returns. The key is the shared `topupCardLockKey`,
 * which also refuses a malformed id (it would lock a key nobody else uses).
 */
export async function lockTopupCard(tx: Tx, cardId: string): Promise<void> {
  assertInTransaction(tx, 'lockTopupCard');
  const key = topupCardLockKey(cardId);
  await tx.$queryRaw`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${key}))`;
}
