import { describe, expect, it } from 'vitest';
import {
  NotInTransactionError,
  WalletNotFoundError,
  appendLedgerEntry,
  lockWallet,
  sumBalance,
} from '../src/index';
import { expectCheck, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { createUser } from './factories';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function userWithWallet(): Promise<string> {
  const user = await createUser();
  await db.wallet.create({ data: { userId: user.id } });
  return user.id;
}

describe('sumBalance', () => {
  it('is 0n for a user without entries', async () => {
    const userId = await userWithWallet();
    expect(await db.$transaction((tx) => sumBalance(tx, userId))).toBe(0n);
  });

  it('adds signed entries of this user only', async () => {
    const userId = await userWithWallet();
    const otherId = await userWithWallet();
    await db.$transaction(async (tx) => {
      await appendLedgerEntry(tx, {
        userId,
        kind: 'TOPUP',
        amountTiyin: 1_000_000n,
        refType: 'PAYMENT',
        refId: 'p1',
      });
      await appendLedgerEntry(tx, {
        userId,
        kind: 'PURCHASE',
        amountTiyin: -250_000n,
        refType: 'ORDER',
        refId: 'o1',
      });
      await appendLedgerEntry(tx, {
        userId: otherId,
        kind: 'TOPUP',
        amountTiyin: 9_999n,
        refType: 'PAYMENT',
        refId: 'p2',
      });
    });
    expect(await db.$transaction((tx) => sumBalance(tx, userId))).toBe(750_000n);
  });
});

describe('sumBalance beyond 2^53', () => {
  it('stays exact: no Number anywhere on the way', async () => {
    const userId = await userWithWallet();
    const big = 2n ** 53n + 1n; // not representable as a JS number
    await db.$transaction(async (tx) => {
      await appendLedgerEntry(tx, {
        userId,
        kind: 'TOPUP',
        amountTiyin: big,
        refType: 'PAYMENT',
        refId: 'big-1',
      });
      await appendLedgerEntry(tx, {
        userId,
        kind: 'TOPUP',
        amountTiyin: 2n,
        refType: 'PAYMENT',
        refId: 'big-2',
      });
      await appendLedgerEntry(tx, {
        userId,
        kind: 'PURCHASE',
        amountTiyin: -1n,
        refType: 'ORDER',
        refId: 'big-3',
      });
    });
    const total = await db.$transaction((tx) => sumBalance(tx, userId));
    expect(total).toBe(2n ** 53n + 2n);
  });
});

describe('transaction-only helpers (M1)', () => {
  const entry = (userId: string) =>
    ({
      userId,
      kind: 'TOPUP',
      amountTiyin: 100n,
      refType: 'PAYMENT',
      refId: 'root-client',
    }) as const;

  it('lockWallet refuses the root client: the lock would be released at once', async () => {
    const userId = await userWithWallet();
    await expect(lockWallet(db, userId)).rejects.toBeInstanceOf(NotInTransactionError);
  });

  it('appendLedgerEntry refuses the root client and writes nothing', async () => {
    const userId = await userWithWallet();
    await expect(appendLedgerEntry(db, entry(userId))).rejects.toBeInstanceOf(
      NotInTransactionError,
    );
    expect(await db.ledgerEntry.count()).toBe(0);
  });

  it('both work with the transaction client', async () => {
    const userId = await userWithWallet();
    await db.$transaction(async (tx) => {
      await lockWallet(tx, userId);
      await appendLedgerEntry(tx, entry(userId));
    });
    expect(await db.ledgerEntry.count()).toBe(1);
  });

  it('pins the Prisma facts the guard relies on', async () => {
    // The root client has $connect; the interactive-transaction client hides it. $transaction
    // is NOT a discriminator: the transaction client still exposes it at runtime.
    expect('$connect' in db).toBe(true);
    const inTransaction = await db.$transaction((tx) =>
      Promise.resolve(['$connect' in tx, '$transaction' in tx]),
    );
    expect(inTransaction).toEqual([false, true]);
  });
});

describe('appendLedgerEntry', () => {
  it('returns the new id and stores the entry as given', async () => {
    const userId = await userWithWallet();
    const { id } = await db.$transaction((tx) =>
      appendLedgerEntry(tx, {
        userId,
        kind: 'ADJUSTMENT',
        amountTiyin: -5n,
        refType: 'ADMIN_ACTION',
        refId: 'audit-1',
        note: 'correction',
      }),
    );
    const row = await db.ledgerEntry.findUniqueOrThrow({ where: { id } });
    expect([row.userId, row.kind, row.amountTiyin, row.refType, row.refId, row.note]).toEqual([
      userId,
      'ADJUSTMENT',
      -5n,
      'ADMIN_ACTION',
      'audit-1',
      'correction',
    ]);
  });

  it('rejects a repeated (refType, refId, kind) and rolls the whole transaction back', async () => {
    const userId = await userWithWallet();
    const entry = {
      userId,
      kind: 'TOPUP',
      amountTiyin: 100n,
      refType: 'PAYMENT',
      refId: 'same',
    } as const;
    await db.$transaction((tx) => appendLedgerEntry(tx, entry));
    await expectPrismaCode(
      db.$transaction(async (tx) => {
        await appendLedgerEntry(tx, { ...entry, refId: 'fresh' });
        await appendLedgerEntry(tx, entry);
      }),
      'P2002',
    );
    expect(await db.ledgerEntry.count()).toBe(1);
    // Same reference with another kind is a different money movement.
    await db.$transaction((tx) =>
      appendLedgerEntry(tx, { ...entry, kind: 'TOPUP_REVERSAL', amountTiyin: -100n }),
    );
  });

  it('lets the sign CHECK refuse a wrong sign for the kind', async () => {
    const userId = await userWithWallet();
    const wrong = [
      { kind: 'TOPUP', amountTiyin: -1n },
      { kind: 'REFUND', amountTiyin: 0n },
      { kind: 'PURCHASE', amountTiyin: 1n },
      { kind: 'TOPUP_REVERSAL', amountTiyin: 1n },
      { kind: 'ADJUSTMENT', amountTiyin: 0n },
    ] as const;
    for (const [i, entry] of wrong.entries()) {
      await expectCheck(
        db.$transaction((tx) =>
          appendLedgerEntry(tx, { userId, refType: 'PAYMENT', refId: `bad-${i}`, ...entry }),
        ),
        'LedgerEntry_amount_sign_check',
      );
    }
  });
});

describe('lockWallet', () => {
  it('throws WalletNotFoundError when the user has no wallet row', async () => {
    const user = await createUser();
    await expect(db.$transaction((tx) => lockWallet(tx, user.id))).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    await expect(db.$transaction((tx) => lockWallet(tx, 'no-such-user'))).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });

  it('makes two concurrent transactions of one user run one after the other', async () => {
    const userId = await userWithWallet();
    const events: string[] = [];
    let firstHoldsLock: () => void = () => undefined;
    const firstLocked = new Promise<void>((resolve) => {
      firstHoldsLock = resolve;
    });

    const first = db.$transaction(async (tx) => {
      await lockWallet(tx, userId);
      events.push('first locked');
      firstHoldsLock();
      await sleep(400);
      await appendLedgerEntry(tx, {
        userId,
        kind: 'TOPUP',
        amountTiyin: 500n,
        refType: 'PAYMENT',
        refId: 'p-first',
      });
      events.push('first done');
    });
    await firstLocked;
    const second = db.$transaction(async (tx) => {
      events.push('second asks');
      await lockWallet(tx, userId);
      events.push('second locked');
      return sumBalance(tx, userId);
    });

    const [, balanceSeenBySecond] = await Promise.all([first, second]);
    expect(events).toEqual(['first locked', 'second asks', 'first done', 'second locked']);
    expect(balanceSeenBySecond).toBe(500n); // the second one saw the first one's committed entry
  });

  it('stops two parallel purchases from spending the same balance twice', async () => {
    const userId = await userWithWallet();
    await db.$transaction((tx) =>
      appendLedgerEntry(tx, {
        userId,
        kind: 'TOPUP',
        amountTiyin: 1_000n,
        refType: 'PAYMENT',
        refId: 'seed',
      }),
    );
    const purchase = (orderId: string) =>
      db.$transaction(async (tx) => {
        await lockWallet(tx, userId);
        if ((await sumBalance(tx, userId)) < 700n) return false;
        await sleep(100); // widen the check-then-write window the lock has to cover
        await appendLedgerEntry(tx, {
          userId,
          kind: 'PURCHASE',
          amountTiyin: -700n,
          refType: 'ORDER',
          refId: orderId,
        });
        return true;
      });
    const results = await Promise.all([purchase('o1'), purchase('o2')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.$transaction((tx) => sumBalance(tx, userId))).toBe(300n);
  });
});
