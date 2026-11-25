import type { Prisma } from '@repo/db';
import { useOrdersE2e } from './orders-e2e.helpers';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Review N2 / audit L1 (probe P3): the session guard checks the block when the request starts, but a
// purchase can then wait on the wallet lock while an operator blocks or freezes the account. The
// flags are read again UNDER the lock, so what was written while it waited counts.
describe('POST /orders (e2e): the account flags are read under the wallet lock', () => {
  const t = useOrdersE2e();

  const facts = async (userId: string, quoteId: string) => {
    const db = t.db();
    const [orders, debits, quote] = await Promise.all([
      db.order.count({ where: { userId } }),
      db.ledgerEntry.count({ where: { userId, kind: 'PURCHASE' } }),
      db.quote.findUniqueOrThrow({ where: { id: quoteId }, select: { usedAt: true } }),
    ]);
    return { orders, debits, used: quote.usedAt !== null };
  };

  /** Until a session of this database waits for a Wallet row lock (the purchase is at the lock). */
  const waitForLockWaiter = async (): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      const rows = await t.db().$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%FROM "Wallet"%FOR UPDATE%'`;
      if ((rows[0]?.n ?? 0) > 0) return;
      await sleep(25);
    }
    throw new Error('the purchase never waited for the wallet lock');
  };

  /**
   * Holds the user's wallet row lock in a transaction of its own; `release()` writes `change` to
   * the user in that transaction and commits it.
   */
  const holdWalletLock = (userId: string, change: Prisma.UserUpdateInput) => {
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = t.db().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "userId" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
        locked();
        await released;
        await tx.user.update({ where: { id: userId }, data: change });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    return { isLocked, release: () => release(), done };
  };

  it.each([
    ['a block', { isBlocked: true }, 'USER_BLOCKED'],
    ['a freeze', { purchaseFrozen: true }, 'PURCHASE_FROZEN'],
  ] as const)(
    '%s written while the purchase waits for the lock: 403, no order, no debit (P3)',
    async (_case, change, code) => {
      const user = await t.newUser();
      await t.fund(user.id, 1_000_000n);
      const quote = await t.quote(user.id);
      const holder = holdWalletLock(user.id, change);
      await holder.isLocked;
      // Past the session guard (the flag is not committed yet), then waiting for the lock.
      const purchase = t.order(user, quote.id);
      try {
        await waitForLockWaiter();
      } finally {
        holder.release();
      }
      await holder.done;
      const res = await purchase;
      expect([res.status, res.body.error?.code]).toEqual([403, code]);
      expect(await facts(user.id, quote.id)).toEqual({ orders: 0, debits: 0, used: false });
    },
  );
});
