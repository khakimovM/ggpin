import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { Db } from '../../../infra/prisma/db';

type Client = PrismaService['client'];

export interface HeldTransaction {
  /** Lets the held transaction finish and waits for its commit. */
  commit(): Promise<void>;
}

/**
 * Runs `work` in a transaction and keeps it open (its row locks held) until `commit()`. Resolves
 * once `work` is done, so the locks are taken when the caller goes on.
 */
export async function heldTransaction(
  db: Client,
  work: (tx: Db) => Promise<unknown>,
): Promise<HeldTransaction> {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = (): void => undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = db.$transaction(
    async (tx) => {
      await work(tx);
      locked();
      await released;
    },
    { timeout: 20_000 },
  );
  // A failing `work` must not leave the caller waiting for a lock that was never taken.
  await Promise.race([isLocked, done]);
  return {
    commit: async () => {
      release();
      await done;
    },
  };
}

/**
 * Polls Postgres until a backend of this database waits on a row lock with a query matching
 * `pattern` (ILIKE). False when `gaveUp()` turns true first (the other side finished without
 * waiting) or after `timeoutMs`.
 */
export async function waitForLockWaiter(
  db: Client,
  pattern: string,
  gaveUp: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !gaveUp()) {
    const [row] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
