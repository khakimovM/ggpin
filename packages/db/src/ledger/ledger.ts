import type { LedgerKind, Prisma } from '../generated/prisma/client.js';

/**
 * The interactive-transaction client (the `tx` of `prisma.$transaction(async (tx) => ...)`).
 * The type alone does NOT keep the root client out: PrismaClient is structurally assignable to
 * it, so `lockWallet(prisma, id)` compiles. `assertInTransaction` closes that gap at runtime.
 */
export type Tx = Prisma.TransactionClient;

/** Thrown when a ledger helper is called with the root client instead of a transaction client. */
export class NotInTransactionError extends Error {
  constructor(readonly helper: string) {
    super(
      `${helper} must run inside prisma.$transaction: it was given the root client, so the wallet lock would be released at once and the write would not be atomic with its state change`,
    );
    this.name = 'NotInTransactionError';
  }
}

/**
 * The interactive-transaction client hides `$connect` (Prisma 7.10.1 runtime: the omitted keys
 * are $connect, $disconnect, $on, $use and $extends), the root client has it. `$transaction` is
 * NOT a usable discriminator: the transaction client still exposes it at runtime although its
 * type omits it. A test pins both facts so a Prisma upgrade that changes them fails loudly.
 */
export function assertInTransaction(tx: Tx, helper: string): void {
  if ('$connect' in tx) throw new NotInTransactionError(helper);
}

/** What a ledger entry points at; with `kind` it forms the idempotency key (refType, refId, kind). */
export const LEDGER_REF_TYPES = ['PAYMENT', 'ORDER', 'REFERRAL', 'ADMIN_ACTION'] as const;
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];

export interface LedgerEntryInput {
  readonly userId: string;
  readonly kind: LedgerKind;
  /** Signed tiyin: + credits the wallet, - debits it. The DB CHECK rejects a wrong sign for the kind. */
  readonly amountTiyin: bigint;
  readonly refType: LedgerRefType;
  readonly refId: string;
  readonly note?: string;
}

/** Thrown by `lockWallet` when the user has no Wallet row (it is created together with the user). */
export class WalletNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`Wallet row not found for user ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}

/**
 * Serialises every money movement of one user: `SELECT ... FOR UPDATE` on the Wallet row, held
 * until the surrounding transaction ends. Call it first, before reading the balance. Throws
 * `NotInTransactionError` when given the root client (the lock would be gone at once).
 */
export async function lockWallet(tx: Tx, userId: string): Promise<void> {
  assertInTransaction(tx, 'lockWallet');
  const rows = await tx.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
  if (rows.length === 0) throw new WalletNotFoundError(userId);
}

/**
 * Appends one entry. A repeat of (refType, refId, kind) is rejected by the unique index
 * (Prisma P2002): the caller decides whether that means "already done". Must run inside the
 * same transaction as the state change that caused the entry.
 */
export async function appendLedgerEntry(tx: Tx, entry: LedgerEntryInput): Promise<{ id: string }> {
  assertInTransaction(tx, 'appendLedgerEntry');
  return tx.ledgerEntry.create({
    data: {
      userId: entry.userId,
      kind: entry.kind,
      amountTiyin: entry.amountTiyin,
      refType: entry.refType,
      refId: entry.refId,
      note: entry.note ?? null,
    },
    select: { id: true },
  });
}

/**
 * The wallet balance: SUM of the user's entries in tiyin, 0n when there are none. A plain read,
 * so it also accepts the root client; only a balance read that decides a write needs the lock.
 */
export async function sumBalance(tx: Tx, userId: string): Promise<bigint> {
  const result = await tx.ledgerEntry.aggregate({
    where: { userId },
    _sum: { amountTiyin: true },
  });
  return result._sum.amountTiyin ?? 0n;
}
