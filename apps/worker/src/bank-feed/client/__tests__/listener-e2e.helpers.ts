import type { Prisma } from '@repo/db';
import { BankFeedAccountRepository } from '../bank-feed-account.repository';

// Helpers of listener.e2e-spec.ts (real ggpin_test Postgres), kept apart for the file size rule.

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inside the holder's transaction: waits until another session waits for an advisory lock this
 * backend holds (pg_locks), instead of a fixed sleep (the a0c0d85 pattern, for advisory locks).
 */
export async function waitUntilBlockedOnMe(tx: Prisma.TransactionClient, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks w
      JOIN pg_locks h ON h.locktype = 'advisory' AND h.granted AND h.pid = pg_backend_pid()
      WHERE w.locktype = 'advisory' AND NOT w.granted AND w.database = h.database
        AND w.classid = h.classid AND w.objid = h.objid AND w.objsubid = h.objsubid`;
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('no session waits for this advisory lock');
    await pause(25);
  }
}

/** The account repository of a fresh deployment: no bank-feed history yet (D-52 r2, L-B). */
export class FreshDeployment extends BankFeedAccountRepository {
  protected override hasHistory(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
