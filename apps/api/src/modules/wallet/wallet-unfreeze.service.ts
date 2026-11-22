import { Inject, Injectable } from '@nestjs/common';
import { WalletNotFoundError } from '@repo/db';
import { checkedId, checkedReason } from '../../common/admin/admin-input';
import {
  actorOfInput,
  auditIdOf,
  checkedAuditActor,
  toAuditColumns,
  type ActorInput,
} from '../../common/admin/audit-actor';
import { confirmActorInTx } from '../../common/admin/audit-actor.check';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { WalletRepository } from './wallet.repository';

export const USER_UNFREEZE = 'USER_UNFREEZE';

export type UnfreezeInput = { readonly userId: string; readonly reason: string } & ActorInput;

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
 * SECURITY: no role check for the CLI (the owner on the server); an ADMIN actor (the panel's
 * OWNER route, S6) is re-read under FOR SHARE first in the transaction (S2-6).
 */
@Injectable()
export class WalletUnfreezeService {
  constructor(
    private readonly repo: WalletRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async unfreeze(input: UnfreezeInput): Promise<Unfreeze> {
    const userId = checkedId('userId', input.userId);
    const reason = checkedReason(input.reason);
    const actor = checkedAuditActor(actorOfInput(input));
    const auditId = auditIdOf(actor);
    return this.repo.transaction(async (tx) => {
      const who = await confirmActorInTx(tx, actor, this.clock.now());
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
        ...(auditId === undefined ? {} : { id: auditId }),
        ...toAuditColumns(actor),
        action: USER_UNFREEZE,
        targetType: 'User',
        targetId: userId,
        before: { purchaseFrozen: true, balanceTiyin: balanceTiyin.toString() },
        after: { purchaseFrozen: false, ...who },
        reason,
      });
      return { applied: true, userId, auditId: audit.id, balanceTiyin };
    });
  }
}
