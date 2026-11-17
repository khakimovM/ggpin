import { Inject, Injectable } from '@nestjs/common';
import type { AdminUser } from '@repo/db';
import { AdminReasonSchema, AdminRoleSchema } from '@repo/shared';
import { checkedId } from '../../../common/admin/admin-input';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import type { Db } from '../../../infra/prisma/db';
import {
  actorAfter,
  checkedActor,
  type CardAdminActor,
  type CheckedActor,
} from '../../payments/card-admin.input';
import { AdminSessionRepository } from '../auth/admin-session.repository';
import { isAllowlisted } from './admin-allowlist';
import { parsed } from './admin-input';
import { AdminUsersRepository, type OwnerRow } from './admin-users.repository';

export interface AdminChangeInput {
  readonly adminId: string;
  readonly reason: string;
  readonly actor: CardAdminActor;
}

export interface LastOwnerConfirmation {
  /** The owner's explicit "yes, leave no usable OWNER" (`--confirm-last-owner`). */
  readonly confirmLastOwner: boolean;
}

export interface AdminChangeResult {
  /**
   * `unchanged`: nothing to do (already in that state, or a parallel change won): nothing
   * written, no audit. `needsLastOwnerConfirm`: the change would leave no usable OWNER (active
   * AND allowlisted) and was not confirmed: nothing written.
   */
  readonly outcome: 'applied' | 'unchanged' | 'needsLastOwnerConfirm';
  readonly adminId: string;
  readonly auditId: string | null;
  readonly revokedSessions: number;
  /** The change left no usable OWNER (only ever with the confirmation). */
  readonly lastOwnerRemoved: boolean;
  /** Usable admins (active AND allowlisted) after the change: 0 = nobody can sign in at all. */
  readonly usableAdmins: number;
  /** The admin's Telegram id is in ADMIN_TELEGRAM_IDS (two keys: row AND allowlist). */
  readonly allowlisted: boolean;
}

/**
 * Deactivation, reactivation and role changes of admin accounts from the owner CLI (D-63 (6),
 * S2 fix round). Each is ONE transaction with its AuditLog row (actor CLI, ADMIN_UPDATE).
 *
 * The last usable OWNER (S2-m2, S2R-5): removing an active OWNER (deactivating it, or moving it
 * to another role) when no other OWNER that is active AND in ADMIN_TELEGRAM_IDS would be left
 * needs `confirmLastOwner`: an owner row whose Telegram id is off the allowlist cannot sign in,
 * so it does not count. The count is taken under a row lock on every active OWNER
 * (AdminUsersRepository.lockActiveOwners), so two parallel changes cannot each remove "the
 * other" owner.
 *
 * Every change that grants or takes away access ends ALL the admin's sessions in the same
 * transaction (S2R-2, S2R-3): deactivation, reactivation (a session opened across a deactivation
 * must never come back to life) and any role change, up or down (a new role means a new login).
 */
@Injectable()
export class AdminLifecycleService {
  constructor(
    private readonly repo: AdminUsersRepository,
    private readonly sessions: AdminSessionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>,
  ) {}

  /** isActive=false and every session of the admin ended. */
  async deactivate(input: AdminChangeInput & LastOwnerConfirmation): Promise<AdminChangeResult> {
    const { adminId, reason, actor } = this.checked(input);
    const now = this.clock.now();
    return this.repo.transaction(async (tx) => {
      const owners = await this.repo.lockActiveOwners(tx);
      const admin = await this.found(adminId, tx);
      if (!admin.isActive) return this.result('unchanged', admin);
      const lastOwner = this.isLastOwner(owners, admin);
      if (lastOwner && !input.confirmLastOwner) return this.result('needsLastOwnerConfirm', admin);
      if (!(await this.repo.deactivate(tx, adminId))) return this.result('unchanged', admin);
      const revokedSessions = await this.sessions.revokeAllOf(tx, adminId, now);
      const after = {
        isActive: false,
        revokedSessions,
        ...confirmed(lastOwner),
        ...actorAfter(actor),
      };
      const auditId = await this.audit(tx, admin, { isActive: true }, after, reason, actor);
      return {
        ...this.result('applied', admin),
        auditId,
        revokedSessions,
        lastOwnerRemoved: lastOwner,
        usableAdmins: await this.usableAdmins(tx),
      };
    });
  }

  /**
   * isActive=true again. Every session of the admin is ended first, in the same transaction: a
   * session that slipped past the deactivation (opened while it committed) never comes back, so
   * the admin always signs in anew.
   */
  async reactivate(input: AdminChangeInput): Promise<AdminChangeResult> {
    const { adminId, reason, actor } = this.checked(input);
    const now = this.clock.now();
    return this.repo.transaction(async (tx) => {
      const admin = await this.found(adminId, tx);
      if (admin.isActive) return this.result('unchanged', admin);
      const revokedSessions = await this.sessions.revokeAllOf(tx, adminId, now);
      if (!(await this.repo.reactivate(tx, adminId))) return this.result('unchanged', admin);
      const allowlisted = isAllowlisted(this.config, admin.telegramId);
      const after = { isActive: true, allowlisted, revokedSessions, ...actorAfter(actor) };
      const auditId = await this.audit(tx, admin, { isActive: false }, after, reason, actor);
      return {
        ...this.result('applied', admin),
        auditId,
        revokedSessions,
        usableAdmins: await this.usableAdmins(tx),
      };
    });
  }

  /** The only way to give OWNER to an existing account. Any change ends its sessions. */
  async setRole(
    input: AdminChangeInput & LastOwnerConfirmation & { readonly role: string },
  ): Promise<AdminChangeResult> {
    const { adminId, reason, actor } = this.checked(input);
    const role = parsed('role', AdminRoleSchema.safeParse(input.role));
    const now = this.clock.now();
    return this.repo.transaction(async (tx) => {
      const owners = await this.repo.lockActiveOwners(tx);
      const admin = await this.found(adminId, tx);
      if (admin.role === role) return this.result('unchanged', admin);
      const lastOwner = this.isLastOwner(owners, admin);
      if (lastOwner && !input.confirmLastOwner) return this.result('needsLastOwnerConfirm', admin);
      if (!(await this.repo.setRole(tx, adminId, admin.role, role))) {
        return this.result('unchanged', admin);
      }
      const revokedSessions = await this.sessions.revokeAllOf(tx, adminId, now);
      const after = { role, revokedSessions, ...confirmed(lastOwner), ...actorAfter(actor) };
      const auditId = await this.audit(tx, admin, { role: admin.role }, after, reason, actor);
      return {
        ...this.result('applied', admin),
        auditId,
        revokedSessions,
        lastOwnerRemoved: lastOwner,
        usableAdmins: await this.usableAdmins(tx),
      };
    });
  }

  /**
   * `admin` is an active OWNER and, without it, no OWNER that is active AND allowlisted is left
   * (owners: the locked active OWNER rows).
   */
  private isLastOwner(owners: readonly OwnerRow[], admin: AdminUser): boolean {
    if (admin.role !== 'OWNER' || !admin.isActive) return false;
    const usableOthers = owners.filter(
      (o) => o.id !== admin.id && isAllowlisted(this.config, o.telegramId),
    );
    return usableOthers.length === 0;
  }

  private async usableAdmins(tx: Db): Promise<number> {
    const ids = await this.repo.activeTelegramIds(tx);
    return ids.filter((id) => isAllowlisted(this.config, id)).length;
  }

  private checked(input: AdminChangeInput) {
    return {
      adminId: checkedId('adminId', input.adminId),
      reason: parsed('reason', AdminReasonSchema.safeParse(input.reason)),
      actor: checkedActor(input.actor),
    };
  }

  private async found(adminId: string, tx: Db): Promise<AdminUser> {
    const admin = await this.repo.findById(adminId, tx);
    if (admin === null) throw new AppError('NOT_FOUND');
    return admin;
  }

  private result(outcome: AdminChangeResult['outcome'], admin: AdminUser): AdminChangeResult {
    return {
      outcome,
      adminId: admin.id,
      auditId: null,
      revokedSessions: 0,
      lastOwnerRemoved: false,
      usableAdmins: 0,
      allowlisted: isAllowlisted(this.config, admin.telegramId),
    };
  }

  private audit(
    tx: Db,
    admin: AdminUser,
    before: Record<string, string | boolean>,
    after: Record<string, string | number | boolean | null>,
    reason: string,
    actor: CheckedActor,
  ): Promise<string> {
    return this.repo.createAudit(tx, {
      actorType: 'CLI',
      actorId: null,
      action: 'ADMIN_UPDATE',
      targetType: 'AdminUser',
      targetId: admin.id,
      before,
      after,
      reason,
      ip: actor.ip,
    });
  }
}

function confirmed(lastOwner: boolean): { lastOwnerConfirmed?: true } {
  return lastOwner ? { lastOwnerConfirmed: true } : {};
}
