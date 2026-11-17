import type { AdminUser } from '@repo/db';
import { permissionsFor, type AdminMeResponse, type AdminSelf } from '@repo/shared';
import type { AppConfig } from '../../../config/config.module';
import { maskTelegramId } from '../admins/admin-allowlist';
import type { AdminPrincipal } from '../common/admin-request';

/** `admin` of the auth responses (docs/04 «Auth»): the Telegram id masked, nothing else. */
export function toAdminSelf(
  admin: Pick<AdminUser, 'id' | 'name' | 'role' | 'telegramId'>,
): AdminSelf {
  return {
    id: admin.id,
    name: admin.name,
    role: admin.role,
    telegramIdMasked: maskTelegramId(admin.telegramId),
  };
}

/**
 * `GET /admin/auth/me`: who is signed in, what the SPA may show (the role's permissions, a UX
 * hint, not a control) and when the session dies (absolute and idle, as of this request).
 */
export function toAdminMe(
  principal: AdminPrincipal,
  config: Pick<AppConfig, 'ADMIN_OPERATOR_REFUND_MAX_TIYIN' | 'ADMIN_CONFIRM_THRESHOLD_TIYIN'>,
): AdminMeResponse {
  return {
    admin: toAdminSelf(principal.admin),
    permissions: permissionsFor(principal.admin.role),
    limits: {
      operatorRefundMaxTiyin: config.ADMIN_OPERATOR_REFUND_MAX_TIYIN.toString(),
      confirmThresholdTiyin: config.ADMIN_CONFIRM_THRESHOLD_TIYIN.toString(),
    },
    session: {
      expiresAt: principal.expiresAt.toISOString(),
      idleExpiresAt: principal.idleExpiresAt.toISOString(),
    },
  };
}
