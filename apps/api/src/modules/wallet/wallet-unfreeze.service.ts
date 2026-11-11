import { Injectable } from '@nestjs/common';
import { WalletNotFoundError } from '@repo/db';
import {
  checkedId,
  checkedIp,
  checkedOperator,
  checkedOsUser,
  checkedReason,
} from '../../common/admin/admin-input';
import { AppError } from '../../common/exceptions/app-error';
import { WalletRepository } from './wallet.repository';

export const USER_UNFREEZE = 'USER_UNFREEZE';

export interface UnfreezeInput {
  readonly userId: string;
  readonly reason: string;
  readonly operator: string;
  readonly ip?: string | null;
  readonly osUser?: string | null;
}

export interface Unfreeze {
  /** False when the user was not frozen: nothing written, no audit. */
  readonly applied: boolean;
  readonly userId: string;
  readonly auditId: string | null;
  readonly balanceTiyin: bigint;
}

/**
 * `user:unfreeze <userId> --reason` (D-41): purchases come back only by the owner's decision,
 * never automatically (a chargeback may be fraud). ONE transaction under the user's wallet lock
 * (the same lock the reversal that froze the account held, so the two never interleave): flag
 * cleared + AuditLog(actorType CLI). A negative balance does not block it: the owner decides.
 * SECURITY: no role check here; only the owner CLI calls it.
 */
@Injectable()
export class WalletUnfreezeService {
  constructor(private readonly repo: WalletRepository) {}

  async unfreeze(input: UnfreezeInput): Promise<Unfreeze> {
    const userId = checkedId('userId', input.userId);
    const reason = checkedReason(input.reason);
    const operator = checkedOperator(input.operator);
    const ip = checkedIp(input.ip);
    const osUser = checkedOsUser(input.osUser);
    return this.repo.transaction(async (tx) => {
      try {
        await this.repo.lock(tx, userId);
      } catch (error) {
        if (error instanceof WalletNotFoundError) throw new AppError('NOT_FOUND');
        throw error;
      }
      const balanceTiyin = await this.repo.balance(userId, tx);
      if (!(await this.repo.unfreezePurchases(tx, userId))) {
        return { applied: false, userId, auditId: null, balanceTiyin };
      }
      const audit = await this.repo.createAudit(tx, {
        ip,
        action: USER_UNFREEZE,
        targetType: 'User',
        targetId: userId,
        before: { purchaseFrozen: true, balanceTiyin: balanceTiyin.toString() },
        after: { purchaseFrozen: false, operator, osUser },
        reason,
      });
      return { applied: true, userId, auditId: audit.id, balanceTiyin };
    });
  }
}
