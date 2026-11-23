import { Inject, Injectable } from '@nestjs/common';
import type { AdminAccountResponse, AdminSessionsRevokeResponse } from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { afterField, type AdminAuditRow } from '../write/admin-write.repository';
import { adminAccountOf } from './admin-account.mapper';
import { AdminUsersRepository } from './admin-users.repository';

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

/**
 * The answer to a replayed admin-management write (docs/04 «Admin» — `Idempotency-Key`): the
 * first call's auditId and `applied: false`, nothing written, no alert. The account is read as it
 * is NOW (ADMIN_CREATE and ADMIN_UPDATE target the AdminUser row); what a revoke ended comes from
 * its row. Only a write that changed something has a row: a no-op's key simply runs again.
 */
@Injectable()
export class AdminAccountsWriteReplays {
  constructor(
    private readonly admins: AdminUsersRepository,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async account(row: AdminAuditRow): Promise<AdminAccountResponse> {
    const account = await this.admins.account(row.targetId, this.clock.now());
    if (account === null) throw new AppError('NOT_FOUND');
    return { admin: adminAccountOf(account, this.config), auditId: row.id, applied: false };
  }

  /**
   * `currentRevoked` is always about the CALLER's session (docs/04 «Adminlar»: the cookie goes
   * with it): true only when the write ended the session that performed it (`after.sessionId`,
   * SA-S6-12) and this replay comes from that same session (its own twin after a failure past
   * the commit, SA I-3). A replay from another live session of the admin answers false.
   */
  sessions(row: AdminAuditRow, callerSessionId: string): Promise<AdminSessionsRevokeResponse> {
    const ended = afterField(row, 'currentRevoked') === true;
    return Promise.resolve({
      revokedSessions: count(afterField(row, 'revokedSessions')),
      currentRevoked: ended && afterField(row, 'sessionId') === callerSessionId,
      auditId: row.id,
      applied: false,
    });
  }
}
