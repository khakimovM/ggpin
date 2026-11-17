import type { AdminUser } from '@repo/db';
import type { AppConfig } from '../../../config/config.module';

/**
 * The second key of admin access (D-63 (3)): a Telegram id the deployment's ADMIN_TELEGRAM_IDS
 * lists. Read from the config on every call, never cached in the database, so removing an id
 * from the env and restarting ends that admin's access at the next request.
 */
export function isAllowlisted(
  config: Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>,
  telegramId: bigint,
): boolean {
  return config.ADMIN_TELEGRAM_IDS.includes(telegramId);
}

/** May this account use the panel right now: an active AdminUser row AND an allowlisted id. */
export function mayUsePanel<T extends Pick<AdminUser, 'isActive' | 'telegramId'>>(
  config: Pick<AppConfig, 'ADMIN_TELEGRAM_IDS'>,
  admin: T | null,
): admin is T {
  return admin !== null && admin.isActive && isAllowlisted(config, admin.telegramId);
}

/** `1234567890` -> `12******90` (docs/04 «Auth»): enough to recognise, useless to contact. */
export function maskTelegramId(telegramId: bigint): string {
  const digits = telegramId.toString();
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}
