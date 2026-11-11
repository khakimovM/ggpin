import type { Tx } from '@repo/db';

/** The parts of a BullMQ job the processor uses; records what it was asked to do. */
export function fakeJob(data: unknown, attemptsMade: number, attempts = 5) {
  const job = {
    id: 'bm-test',
    data,
    attemptsMade,
    opts: { attempts },
    delayedUntil: null as number | null,
    updateData(next: unknown): Promise<void> {
      job.data = next;
      return Promise.resolve();
    },
    moveToDelayed(timestamp: number): Promise<void> {
      job.delayedUntil = timestamp;
      return Promise.resolve();
    },
  };
  return job;
}

/**
 * Waits (inside the holder's own transaction) until another session is BLOCKED on a lock it
 * holds: an advisory lock (card lock) or this transaction's id (a row / unique-key wait). Reads
 * pg_locks instead of sleeping, so the race is forced, not hoped for. E2E runs are serialised by
 * the e2e lock, so no foreign session waits in the test database.
 */
export async function waitForBlockedSession(
  tx: Tx,
  on: 'advisory' | 'myTransaction',
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows =
      on === 'advisory'
        ? await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
        : await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'transactionid' AND NOT granted
              AND transactionid = pg_current_xact_id()::xid`;
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`no session blocked on ${on} lock`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
