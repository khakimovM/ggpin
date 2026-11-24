// The one builder of the admin-management writes (plan S9b): the code is bound to the
// confirmation body (docs/04 «Binding»), so the confirmation and the action body come from the
// same change here, and a PATCH carries only the fields that really change.
import {
  AdminNameSchema,
  PanelAssignableRoleSchema,
  TelegramIdStringSchema,
  type AdminAccount,
  type AdminConfirmationBody,
  type AdminCreateBody,
  type AdminOtpAnswer,
  type AdminUpdateBody,
  type PanelAssignableRole,
} from '@repo/shared';
import type { ActionFields } from '../../lib/idempotency';

/** What a PATCH may change; a field left out stays as it is. */
export interface AdminChange {
  name?: string;
  role?: PanelAssignableRole;
  isActive?: boolean;
}

type Current = Pick<AdminAccount, 'name' | 'role' | 'isActive'>;

/**
 * The fields of `wanted` that differ from the row (a name compared trimmed, as the server stores
 * it); null when nothing would change, so the dialog never sends an empty PATCH.
 */
export function adminChangeOf(row: Current, wanted: AdminChange): AdminChange | null {
  const change: AdminChange = {};
  if (wanted.name !== undefined && wanted.name.trim() !== row.name)
    change.name = wanted.name.trim();
  if (wanted.role !== undefined && wanted.role !== row.role) change.role = wanted.role;
  if (wanted.isActive !== undefined && wanted.isActive !== row.isActive) {
    change.isActive = wanted.isActive;
  }
  return Object.keys(change).length === 0 ? null : change;
}

/** Whether `admin` is in the state `change` asked for (the check after a replayed answer). */
export function adminMatches(admin: AdminAccount, change: AdminChange): boolean {
  return (
    (change.name === undefined || admin.name === change.name) &&
    (change.role === undefined || admin.role === change.role) &&
    (change.isActive === undefined || admin.isActive === change.isActive)
  );
}

export function updateConfirmation(targetId: string, change: AdminChange): AdminConfirmationBody {
  return { action: 'admins.update', targetId, ...change };
}

export function updateBody(
  change: AdminChange,
  reason: string,
  otp: AdminOtpAnswer,
): AdminUpdateBody {
  return { ...change, reason, otp };
}

/** The add dialog's fields as typed. */
export interface NewAdminDraft {
  telegramId: string;
  name: string;
  role: PanelAssignableRole;
}

/** The draft as it will be sent, or null while a field is not valid yet. */
export function newAdminOf(draft: NewAdminDraft): NewAdminDraft | null {
  const telegramId = draft.telegramId.trim();
  if (!telegramIdValid(telegramId) || !adminNameValid(draft.name)) return null;
  return { telegramId, name: draft.name.trim(), role: draft.role };
}

export function createConfirmation(admin: NewAdminDraft): AdminConfirmationBody {
  return { action: 'admins.create', ...admin };
}

export function createBody(
  admin: NewAdminDraft,
  reason: string,
  otp: AdminOtpAnswer,
): AdminCreateBody {
  return { ...admin, reason, otp };
}

export function telegramIdValid(value: string): boolean {
  return TelegramIdStringSchema.safeParse(value.trim()).success;
}

export function adminNameValid(value: string): boolean {
  return AdminNameSchema.safeParse(value).success;
}

/** A role kept with an unknown outcome (memory only), when it is still one the panel may give. */
export function roleFrom(fields: ActionFields | null, fallback: PanelAssignableRole) {
  const parsed = PanelAssignableRoleSchema.safeParse(fields?.role);
  return parsed.success ? parsed.data : fallback;
}

/** A text field kept with an unknown outcome, or `fallback`. */
export function textFrom(fields: ActionFields | null, key: string, fallback: string): string {
  const value = fields?.[key];
  return typeof value === 'string' ? value : fallback;
}
