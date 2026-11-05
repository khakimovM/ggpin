import { AppError } from '../../common/exceptions/app-error';
import type { Db } from '../../infra/prisma/db';
import type { WalletChange } from './wallet-admin.service';
import type { WalletRepository } from './wallet.repository';

export type Committed = Omit<WalletChange, 'alertQueued'>;

export const WALLET_ADJUST = 'WALLET_ADJUST';
export const PAYMENT_REVERSE = 'PAYMENT_REVERSE';

// Replays: a second run of an already committed command finds its first run and writes nothing.

export async function replayed(
  repo: WalletRepository,
  tx: Db,
  userId: string,
  auditId: string,
  ledgerEntryId: string,
): Promise<Committed> {
  return {
    applied: false,
    userId,
    auditId,
    ledgerEntryId,
    balanceTiyin: await repo.balance(userId, tx),
    frozen: await repo.isPurchaseFrozen(tx, userId),
    newlyFrozen: false,
  };
}

// Same id AND same body is a retry; anything else under that id is a different request.
export async function findAdjustReplay(
  repo: WalletRepository,
  tx: Db,
  key: { userId: string; auditId: string; amount: bigint; reason: string },
): Promise<Committed | null> {
  const audit = await repo.findAudit(tx, key.auditId);
  if (audit === null) return null;
  if (
    audit.action !== WALLET_ADJUST ||
    audit.targetType !== 'User' ||
    audit.targetId !== key.userId ||
    audit.reason !== key.reason
  ) {
    throw new AppError('IDEMPOTENCY_CONFLICT');
  }
  const entry = await repo.findEntry(tx, {
    userId: key.userId,
    refType: 'ADMIN_ACTION',
    refId: key.auditId,
    kind: 'ADJUSTMENT',
  });
  if (entry === null) throw new AppError('INTERNAL_ERROR');
  if (entry.amountTiyin !== key.amount) throw new AppError('IDEMPOTENCY_CONFLICT');
  return replayed(repo, tx, key.userId, key.auditId, entry.id);
}

export async function reversalReplay(
  repo: WalletRepository,
  tx: Db,
  userId: string,
  paymentId: string,
  reason: string,
  ledgerEntryId: string,
): Promise<Committed> {
  const audit = await repo.findAuditByTarget(tx, PAYMENT_REVERSE, 'Payment', paymentId);
  if (audit === null) throw new AppError('INTERNAL_ERROR');
  if (audit.reason !== reason) throw new AppError('IDEMPOTENCY_CONFLICT');
  return replayed(repo, tx, userId, audit.id, ledgerEntryId);
}
