import type { Logger } from '@nestjs/common';
import { WalletNotFoundError } from '@repo/db';
import { scrubSecretsInText } from '@repo/shared';
import { AppError } from '../../common/exceptions/app-error';
import type { Db } from '../../infra/prisma/db';
import type { Committed } from './wallet-admin.replay';
import type { WalletChange } from './wallet-admin.types';
import type { WalletCache } from './wallet-cache';
import type { WalletFrozenAlert } from './wallet-frozen-alert';
import { isUniqueViolation, type AuditEntryData, type WalletRepository } from './wallet.repository';

/**
 * The write steps every owner money correction shares (adjust and reverseTopup): the wallet
 * lock, the AuditLog row, the purchaseFrozen flag and the after-commit effects. A plain class
 * built by WalletAdminService, so both paths behave the same.
 */
export class WalletAdminSteps {
  constructor(
    private readonly repo: WalletRepository,
    private readonly cache: WalletCache,
    private readonly alert: WalletFrozenAlert,
    private readonly logger: Logger,
  ) {}

  // A user without a Wallet row is "no such user" to the operator, not a server error.
  async lock(tx: Db, userId: string): Promise<void> {
    try {
      await this.repo.lock(tx, userId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) throw new AppError('NOT_FOUND');
      throw error;
    }
  }

  // A reused AuditLog id that slipped past the replay check (two commands with the same id for
  // DIFFERENT users hold different wallet locks) hits the primary key: a conflict, not a 500.
  async createAudit(tx: Db, data: AuditEntryData): Promise<{ id: string }> {
    try {
      return await this.repo.createAudit(tx, data);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('IDEMPOTENCY_CONFLICT');
      throw error;
    }
  }

  // A negative balance raises the flag. The flag is never cleared here (D-41: owner CLI
  // `user:unfreeze`), so `frozen` reports the flag as it is and the alert goes out only on the
  // false -> true flip: an already frozen account does not alert again.
  async applied(
    tx: Db,
    userId: string,
    auditId: string,
    ledgerEntryId: string,
    balanceTiyin: bigint,
  ): Promise<Committed> {
    const newlyFrozen = balanceTiyin < 0n && (await this.repo.freezePurchases(tx, userId));
    const frozen = newlyFrozen || (await this.repo.isPurchaseFrozen(tx, userId));
    return { applied: true, userId, auditId, ledgerEntryId, balanceTiyin, frozen, newlyFrozen };
  }

  // Best effort on purpose: the money is already committed, so a Redis hiccup must not turn a
  // done correction into an error (a CLI retry would only replay it).
  async afterCommit(committed: Committed): Promise<WalletChange> {
    if (!committed.applied) return { ...committed, alertQueued: false };
    await this.cache.invalidate(committed.userId);
    if (!committed.newlyFrozen) return { ...committed, alertQueued: false };
    try {
      await this.alert.raise(committed.userId, committed.ledgerEntryId);
      return { ...committed, alertQueued: true };
    } catch (error) {
      const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'unknown error';
      this.logger.error(`walletFrozen alert for ${committed.ledgerEntryId} not queued: ${reason}`);
      return { ...committed, alertQueued: false };
    }
  }
}
