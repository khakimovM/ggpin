// `/api/v1/admin/admins*` and `/api/v1/admin/sessions/:id/revoke` (docs/04 "Admin" — admins;
// docs/09 §10; plan S9; D-63 (4), (6)). OWNER only; every write needs the acting OWNER's code.
// The panel adds only OPERATOR and SUPPORT: an OWNER is created with the CLI (`admin:add`). A new
// admin also needs its Telegram id in `ADMIN_TELEGRAM_IDS` (devops) before it can sign in.
import { z } from 'zod';
import { ResourceIdSchema } from '../common-schemas';
import {
  AdminNameSchema,
  AdminOtpAnswerSchema,
  AdminReasonSchema,
  IsoDateTimeSchema,
  TelegramIdStringSchema,
  adminActionResultShape,
} from './admin-common-schemas';
import { AdminRoleSchema, PanelAssignableRoleSchema } from './admin-roles';

const CountSchema = z.number().int().min(0);
export const AdminAccountSchema = z.strictObject({
  id: ResourceIdSchema,
  telegramId: TelegramIdStringSchema,
  name: z.string(),
  role: AdminRoleSchema,
  isActive: z.boolean(),
  /** In `ADMIN_TELEGRAM_IDS` now; false = can't sign in until devops adds the id. */
  allowlisted: z.boolean(),
  lastLoginAt: IsoDateTimeSchema.nullable(),
  activeSessions: CountSchema,
  createdAt: IsoDateTimeSchema,
});
export type AdminAccount = z.infer<typeof AdminAccountSchema>;

export const AdminAccountListResponseSchema = z.array(AdminAccountSchema);
export type AdminAccountListResponse = z.infer<typeof AdminAccountListResponseSchema>;

/** Sessions of one admin, newest first. `userAgent` arrives with the 9-B migration (null before). */
export const AdminSessionListResponseSchema = z.array(
  z.strictObject({
    id: ResourceIdSchema,
    createdAt: IsoDateTimeSchema,
    lastUsedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    idleExpiresAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.nullable(),
    ipMasked: z.string().nullable(),
    userAgent: z.string().nullable(),
    current: z.boolean(),
  }),
);
export type AdminSessionListResponse = z.infer<typeof AdminSessionListResponseSchema>;

/** Admin-management writes carry the code always (D-63 (4)); there is no amount to re-type. */
const managementShape = {
  reason: AdminReasonSchema,
  otp: AdminOtpAnswerSchema,
} as const;

export const AdminCreateBodySchema = z.strictObject({
  telegramId: TelegramIdStringSchema,
  name: AdminNameSchema,
  role: PanelAssignableRoleSchema,
  ...managementShape,
});
export type AdminCreateBody = z.infer<typeof AdminCreateBodySchema>;

/**
 * `PATCH /admin/admins/:id`: OPERATOR ↔ SUPPORT, rename, or deactivate (`isActive: false` ends its
 * sessions in the same transaction). An OWNER row cannot be changed from the panel.
 */
export const AdminUpdateBodySchema = z
  .strictObject({
    name: AdminNameSchema.optional(),
    role: PanelAssignableRoleSchema.optional(),
    isActive: z.boolean().optional(),
    ...managementShape,
  })
  .refine((b) => b.name !== undefined || b.role !== undefined || b.isActive !== undefined, {
    message: 'nothing to change',
    path: [],
  });
export type AdminUpdateBody = z.infer<typeof AdminUpdateBodySchema>;

export const AdminManagementBodySchema = z.strictObject(managementShape);
export type AdminManagementBody = z.infer<typeof AdminManagementBodySchema>;

export const AdminAccountResponseSchema = z.strictObject({
  admin: AdminAccountSchema,
  ...adminActionResultShape,
});
export type AdminAccountResponse = z.infer<typeof AdminAccountResponseSchema>;

/** Revoking one's own current session also clears the cookie (like logout). */
export const AdminSessionsRevokeResponseSchema = z.strictObject({
  revokedSessions: CountSchema,
  currentRevoked: z.boolean(),
  ...adminActionResultShape,
});
export type AdminSessionsRevokeResponse = z.infer<typeof AdminSessionsRevokeResponseSchema>;
