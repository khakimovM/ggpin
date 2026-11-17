import { Inject, Injectable } from '@nestjs/common';
import type { AdminUser } from '@repo/db';
import {
  AdminNameSchema,
  AdminReasonSchema,
  AdminRoleSchema,
  TelegramIdStringSchema,
} from '@repo/shared';
import { validationError } from '../../../common/admin/admin-input';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { isUniqueViolation } from '../../payments/db-errors';
import { actorAfter, checkedActor, type CardAdminActor } from '../../payments/card-admin.input';
import { isAllowlisted } from './admin-allowlist';
import { parsed } from './admin-input';
import { AdminUsersRepository, type AdminListRow } from './admin-users.repository';

const TELEGRAM_ID_INDEX = 'AdminUser_telegramId_key';

export interface AdminAddInput {
  readonly telegramId: string;
  readonly name: string;
  readonly role: string;
  readonly reason: string;
  readonly actor: CardAdminActor;
}

export interface AdminAddResult {
  readonly admin: AdminUser;
  readonly auditId: string;
  /** False: the id is not in ADMIN_TELEGRAM_IDS yet, the admin cannot sign in (two keys). */
  readonly allowlisted: boolean;
}

export interface AdminListItem extends AdminListRow {
  readonly allowlisted: boolean;
}

/**
 * Admin accounts from the owner CLI (D-46, D-63 (6)): the only way to create an OWNER, and the
 * bootstrap of the very first admin. Every change is ONE transaction with its AuditLog row
 * (actor CLI, the operator and OS account in `after`, the SSH address in `ip`). The panel's own
 * admin management (S11) adds its routes on these services later. Deactivation, reactivation
 * and role changes live in AdminLifecycleService.
 */
@Injectable()
export class AdminAccountsService {
  constructor(
    private readonly repo: AdminUsersRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>,
  ) {}

  async addFromCli(input: AdminAddInput): Promise<AdminAddResult> {
    const telegramId = BigInt(
      parsed('telegramId', TelegramIdStringSchema.safeParse(input.telegramId)),
    );
    const name = parsed('name', AdminNameSchema.safeParse(input.name));
    const role = parsed('role', AdminRoleSchema.safeParse(input.role));
    const reason = parsed('reason', AdminReasonSchema.safeParse(input.reason));
    const actor = checkedActor(input.actor);
    const allowlisted = isAllowlisted(this.config, telegramId);
    try {
      return await this.repo.transaction(async (tx) => {
        // An existing row (active or not) is never overwritten: a role change or a
        // re-activation is its own audited action, not a side effect of "add".
        if ((await this.repo.findByTelegramId(telegramId, tx)) !== null) {
          throw validationError('telegramId', 'ADMIN_EXISTS');
        }
        const admin = await this.repo.create(tx, { telegramId, name, role });
        const auditId = await this.repo.createAudit(tx, {
          actorType: 'CLI',
          actorId: null,
          action: 'ADMIN_CREATE',
          targetType: 'AdminUser',
          targetId: admin.id,
          before: null,
          after: {
            telegramId: telegramId.toString(),
            name,
            role,
            isActive: true,
            allowlisted,
            ...actorAfter(actor),
          },
          reason,
          ip: actor.ip,
        });
        return { admin, auditId, allowlisted };
      });
    } catch (error) {
      // A parallel add of the same id won the unique index between our read and our insert.
      if (isUniqueViolation(error, TELEGRAM_ID_INDEX)) {
        throw validationError('telegramId', 'ADMIN_EXISTS');
      }
      throw error;
    }
  }

  async list(): Promise<AdminListItem[]> {
    const rows = await this.repo.list(this.clock.now());
    return rows.map((row) => ({ ...row, allowlisted: isAllowlisted(this.config, row.telegramId) }));
  }
}
