import { Inject, Injectable } from '@nestjs/common';
import { WalletNotFoundError } from '@repo/db';
import { checkedId, checkedReason, validationError } from '../../../common/admin/admin-input';
import { isAnAdminsUser } from '../../../common/admin/admin-target.repository';
import { checkedAuditActor, type AdminActor } from '../../../common/admin/audit-actor';
import { confirmActorInTx, type ActorAfter } from '../../../common/admin/audit-actor.check';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import type { Db } from '../../../infra/prisma/db';
import { ReviewEffects } from '../../payments/review-effects';
import { WalletUnfreezeService } from '../../wallet/wallet-unfreeze.service';
import { AdminUserActionsRepository, type UserFlags } from './admin-user-actions.repository';

/** The answer when the user's Telegram account belongs to an admin (SA-S6-1). */
export const ADMIN_ACCOUNT_REASON = 'ADMIN_ACCOUNT';

/**
 * SA-S6-1: the store account of ANY admin (by Telegram id, active or not) is never blocked or
 * frozen from the panel, so an OPERATOR cannot lock the OWNER out of the bot (where the login
 * code and the step-up codes arrive). Read under the wallet lock; the CLI does not use these
 * routes. Answer: `400 fields[{ path: 'userId', code: 'ADMIN_ACCOUNT' }]`.
 */
async function refuseAdminAccount(tx: Db, userId: string): Promise<void> {
  if (await isAnAdminsUser(tx, userId)) throw validationError('userId', ADMIN_ACCOUNT_REASON);
}

/** `AdminUserState` before it is serialised (docs/04 «Foydalanuvchilar»). */
export interface UserStateChange extends UserFlags {
  readonly userId: string;
  readonly revokedSessions: number;
  readonly auditId: string | null;
  readonly applied: boolean;
}

interface Mutation {
  /** False: the user already was in the asked state; nothing is written. */
  readonly changed: boolean;
  readonly revokedSessions: number;
}

/**
 * The admin's account actions on a user (docs/04 «Foydalanuvchilar», D-63 (9), Q20): block,
 * unblock, freeze, unfreeze, end the web sessions, add a note. Each is ONE transaction that
 * re-reads the acting admin first (FOR SHARE, S2-6), then takes the user's wallet lock (the one
 * every purchase and money movement holds, so a purchase in flight finishes before a block, and
 * one that starts after it sees the flag), changes the flag and writes the AuditLog row whose id
 * is the request's Idempotency-Key row. The owner's `adminAction` alert follows the commit.
 */
@Injectable()
export class AdminUserActionsService {
  constructor(
    private readonly repo: AdminUserActionsRepository,
    private readonly unfreezes: WalletUnfreezeService,
    private readonly effects: ReviewEffects,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Blocked, and every web session ended in the same transaction (D-63 (9)). */
  block(actor: AdminActor, userId: string, reason: string): Promise<UserStateChange> {
    return this.stateAction(actor, userId, reason, 'USER_BLOCK', async (tx, now) => {
      await refuseAdminAccount(tx, userId);
      if (!(await this.repo.setBlocked(tx, userId, true))) {
        return { changed: false, revokedSessions: 0 };
      }
      return { changed: true, revokedSessions: await this.repo.revokeWebSessions(tx, userId, now) };
    });
  }

  unblock(actor: AdminActor, userId: string, reason: string): Promise<UserStateChange> {
    return this.stateAction(actor, userId, reason, 'USER_UNBLOCK', async (tx) => ({
      changed: await this.repo.setBlocked(tx, userId, false),
      revokedSessions: 0,
    }));
  }

  /** Purchases frozen by hand; only the owner lifts it (unfreeze, D-41). */
  freeze(actor: AdminActor, userId: string, reason: string): Promise<UserStateChange> {
    return this.stateAction(actor, userId, reason, 'USER_FREEZE', async (tx) => {
      await refuseAdminAccount(tx, userId);
      return { changed: await this.repo.freeze(tx, userId), revokedSessions: 0 };
    });
  }

  /** The owner CLI's `user:unfreeze` service, with this admin as the actor. */
  async unfreeze(actor: AdminActor, userId: string, reason: string): Promise<UserStateChange> {
    const done = await this.unfreezes.unfreeze({ userId, reason, actor });
    if (done.applied && done.auditId !== null) await this.effects.adminAction(done.auditId);
    const flags = await this.repo.flags(this.repoClient(), done.userId);
    if (flags === null) throw new AppError('NOT_FOUND');
    return { userId: done.userId, ...flags, revokedSessions: 0, ...this.result(done.auditId) };
  }

  /** Ends every live web session (the user must sign in again); always one audit row. */
  async revokeSessions(
    actor: AdminActor,
    rawUserId: string,
    reason: string,
  ): Promise<{ userId: string; revokedSessions: number; auditId: string; applied: true }> {
    const userId = checkedId('userId', rawUserId);
    const why = checkedReason(reason);
    const checked = checkedAuditActor(actor);
    const now = this.clock.now();
    const revokedSessions = await this.repo.transaction(async (tx) => {
      const who = await confirmActorInTx(tx, checked, now);
      if ((await this.repo.flags(tx, userId)) === null) throw new AppError('NOT_FOUND');
      const count = await this.repo.revokeWebSessions(tx, userId, now);
      await this.repo.createAudit(tx, {
        ...this.columns(actor, userId),
        action: 'USER_SESSIONS_REVOKE',
        after: { revokedSessions: count, ...who },
        reason: why,
      });
      return count;
    });
    await this.effects.adminAction(actor.request.auditId);
    return { userId, revokedSessions, auditId: actor.request.auditId, applied: true };
  }

  /** A note on the user (`USER_NOTE`, every role); notes are not alerted. */
  async note(
    actor: AdminActor,
    rawUserId: string,
    text: string,
  ): Promise<{ auditId: string; createdAt: Date }> {
    const userId = checkedId('userId', rawUserId);
    const checked = checkedAuditActor(actor);
    const now = this.clock.now();
    await this.repo.transaction(async (tx) => {
      const who = await confirmActorInTx(tx, checked, now);
      if ((await this.repo.flags(tx, userId)) === null) throw new AppError('NOT_FOUND');
      await this.repo.createAudit(tx, {
        ...this.columns(actor, userId),
        action: 'USER_NOTE',
        after: { text, ...who },
      });
    });
    return { auditId: actor.request.auditId, createdAt: now };
  }

  private async stateAction(
    actor: AdminActor,
    rawUserId: string,
    reason: string,
    action: string,
    mutate: (tx: Db, now: Date) => Promise<Mutation>,
  ): Promise<UserStateChange> {
    const userId = checkedId('userId', rawUserId);
    const why = checkedReason(reason);
    const checked = checkedAuditActor(actor);
    const now = this.clock.now();
    const change = await this.repo.transaction(async (tx): Promise<UserStateChange> => {
      const who: ActorAfter = await confirmActorInTx(tx, checked, now);
      await this.lockWallet(tx, userId);
      const before = await this.repo.flags(tx, userId);
      if (before === null) throw new AppError('NOT_FOUND');
      const done = await mutate(tx, now);
      if (!done.changed) return { userId, ...before, revokedSessions: 0, ...this.result(null) };
      const after = await this.repo.flags(tx, userId);
      if (after === null) throw new AppError('INTERNAL_ERROR');
      await this.repo.createAudit(tx, {
        ...this.columns(actor, userId),
        action,
        before: { ...before },
        after: { ...after, revokedSessions: done.revokedSessions, ...who },
        reason: why,
      });
      return {
        userId,
        ...after,
        revokedSessions: done.revokedSessions,
        ...this.result(actor.request.auditId),
      };
    });
    if (change.applied && change.auditId !== null) await this.effects.adminAction(change.auditId);
    return change;
  }

  private async lockWallet(tx: Db, userId: string): Promise<void> {
    try {
      await this.repo.lockWallet(tx, userId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) throw new AppError('NOT_FOUND');
      throw error;
    }
  }

  private columns(actor: AdminActor, userId: string) {
    return { id: actor.request.auditId, actorId: actor.adminId, ip: actor.ip, targetId: userId };
  }

  private result(auditId: string | null): { auditId: string | null; applied: boolean } {
    return { auditId, applied: auditId !== null };
  }

  private repoClient(): Db {
    return this.repo.client();
  }
}
