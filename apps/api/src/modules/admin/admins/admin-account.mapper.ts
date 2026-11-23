import type { AdminAccount } from '@repo/shared';
import type { AppConfig } from '../../../config/config.module';
import { isAllowlisted } from './admin-allowlist';
import type { AdminAccountRow } from './admin-users.repository';

/**
 * `AdminAccount` (docs/04 «Adminlar») of a row read with its live sessions and newest login: the
 * one map of the list, the writes and their replays. `allowlisted` is read from the config on
 * every call, like the guard: false = cannot sign in yet.
 */
export function adminAccountOf(
  row: AdminAccountRow,
  config: Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>,
): AdminAccount {
  return {
    id: row.id,
    telegramId: row.telegramId.toString(),
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    allowlisted: isAllowlisted(config, row.telegramId),
    lastLoginAt: row.lastLoginAt === null ? null : row.lastLoginAt.toISOString(),
    activeSessions: row.activeSessions,
    createdAt: row.createdAt.toISOString(),
  };
}
