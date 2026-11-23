import { Inject, Injectable } from '@nestjs/common';
import {
  ADMIN_SESSION_IDLE_SEC,
  type AdminAccountListResponse,
  type AdminSessionListResponse,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { iso, isoOrNull, shownIp } from '../read/admin-read-view';
import { AdminAccountsReadRepository } from './admin-accounts-read.repository';
import { adminAccountOf } from './admin-account.mapper';
import { AdminUsersRepository } from './admin-users.repository';

const MS = 1000;

/** The OWNER's admin list and session lists (docs/04 «Adminlar»; read only, writes are S9). */
@Injectable()
export class AdminAccountsReadService {
  constructor(
    private readonly admins: AdminUsersRepository,
    private readonly repo: AdminAccountsReadRepository,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(): Promise<AdminAccountListResponse> {
    const rows = await this.admins.list(this.clock.now());
    const logins = await this.repo.lastLogins(rows.map((row) => row.id));
    return rows.map((row) =>
      adminAccountOf({ ...row, lastLoginAt: logins.get(row.id) ?? null }, this.config),
    );
  }

  /** An admin's sessions, newest first; `current` marks the caller's own. */
  async sessions(adminId: string, currentSessionId: string): Promise<AdminSessionListResponse> {
    if (!(await this.repo.exists(adminId))) throw new AppError('NOT_FOUND');
    const rows = await this.repo.sessions(adminId);
    return rows.map((row) => {
      const idle = row.lastUsedAt.getTime() + ADMIN_SESSION_IDLE_SEC * MS;
      return {
        id: row.id,
        createdAt: iso(row.createdAt),
        lastUsedAt: iso(row.lastUsedAt),
        expiresAt: iso(row.expiresAt),
        idleExpiresAt: iso(new Date(Math.min(row.expiresAt.getTime(), idle))),
        revokedAt: isoOrNull(row.revokedAt),
        ipMasked: shownIp(row.ip),
        // AdminSession has no userAgent column until the 9-B migration (docs/04).
        userAgent: null,
        current: row.id === currentSessionId,
      };
    });
  }
}
