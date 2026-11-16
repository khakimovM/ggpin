// `/api/v1/admin/auth/*` (docs/04 "Admin" — auth; phase 9 plan 4.2, 4.3, 4.9). The login reuses
// the web OTP flow's shapes (nonce, status, 6-digit code) with the `admin_` start payload.
import { z } from 'zod';
import { LOGIN_STATUSES } from '../auth/auth-schemas';
import { LOGIN_NONCE_PATTERN } from '../auth/start-payload';
import { ResourceIdSchema } from '../common-schemas';
import { TiyinStringSchema } from '../money-schemas';
import { IsoDateTimeSchema } from './admin-common-schemas';
import { AdminPermissionSchema } from './admin-permissions';
import { AdminRoleSchema } from './admin-roles';

const NonceSchema = z.string().regex(LOGIN_NONCE_PATTERN);

export const AdminLoginStartBodySchema = z.strictObject({});
export type AdminLoginStartBody = z.infer<typeof AdminLoginStartBodySchema>;

export const AdminLoginStartResponseSchema = z.strictObject({
  nonce: NonceSchema,
  botUrl: z.string().regex(/^https:\/\/t\.me\/[A-Za-z0-9_]{1,32}\?start=admin_[A-Za-z0-9_-]{43}$/),
});
export type AdminLoginStartResponse = z.infer<typeof AdminLoginStartResponseSchema>;

export const AdminLoginStatusParamsSchema = z.strictObject({ nonce: NonceSchema });
export type AdminLoginStatusParams = z.infer<typeof AdminLoginStatusParamsSchema>;

/** Same values as the web login; a Telegram id outside the allowlist simply stays PENDING. */
export const AdminLoginStatusResponseSchema = z.strictObject({ status: z.enum(LOGIN_STATUSES) });
export type AdminLoginStatusResponse = z.infer<typeof AdminLoginStatusResponseSchema>;

export const AdminLoginVerifyBodySchema = z.strictObject({
  nonce: NonceSchema,
  code: z.string().regex(/^\d{6}$/),
});
export type AdminLoginVerifyBody = z.infer<typeof AdminLoginVerifyBodySchema>;

/** The signed-in admin. The Telegram id is masked (`12******89`): the SPA has no use for it. */
export const AdminSelfSchema = z.strictObject({
  id: ResourceIdSchema,
  name: z.string(),
  role: AdminRoleSchema,
  telegramIdMasked: z.string().max(32),
});
export type AdminSelf = z.infer<typeof AdminSelfSchema>;

export const AdminLoginVerifyResponseSchema = z.strictObject({ admin: AdminSelfSchema });
export type AdminLoginVerifyResponse = z.infer<typeof AdminLoginVerifyResponseSchema>;

export const AdminLogoutResponseSchema = z.strictObject({});
export type AdminLogoutResponse = z.infer<typeof AdminLogoutResponseSchema>;

/**
 * `GET /admin/auth/me`. `permissions` = `permissionsFor(role)`; `limits` are the API's current
 * env values, so the SPA can hide a button the server would refuse anyway (UX, not a control).
 */
export const AdminMeResponseSchema = z.strictObject({
  admin: AdminSelfSchema,
  permissions: z.array(AdminPermissionSchema),
  limits: z.strictObject({
    operatorRefundMaxTiyin: TiyinStringSchema,
    confirmThresholdTiyin: TiyinStringSchema,
  }),
  session: z.strictObject({
    expiresAt: IsoDateTimeSchema,
    idleExpiresAt: IsoDateTimeSchema,
  }),
});
export type AdminMeResponse = z.infer<typeof AdminMeResponseSchema>;
