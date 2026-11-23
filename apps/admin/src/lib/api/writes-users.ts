// Writes on a user (docs/04 «Foydalanuvchilar», plan S6/S7): every one carries the registry's
// Idempotency-Key; the bodies come from the dialogs' builders and are typed by the shared schemas.
import {
  AdminAdjustPreviewResponseSchema,
  AdminAdjustWalletResponseSchema,
  AdminNoteResponseSchema,
  AdminUserSessionsRevokeResponseSchema,
  AdminUserStateResponseSchema,
  type AdminAdjustWalletBody,
  type AdminNoteBody,
  type AdminReasonBody,
} from '@repo/shared';
import { apiFetch } from './client';

const id = (value: string) => encodeURIComponent(value);

/** The four state actions and their paths (block ends every web session too, D-63 (9)). */
export const USER_STATE_ACTIONS = {
  'users.block': 'block',
  'users.unblock': 'unblock',
  'users.freeze': 'freeze',
  'users.unfreeze': 'unfreeze',
} as const;
export type UserStateAction = keyof typeof USER_STATE_ACTIONS;

export const changeUserState = (
  action: UserStateAction,
  userId: string,
  body: AdminReasonBody,
  idempotencyKey: string,
) =>
  apiFetch(
    {
      method: 'POST',
      path: `/admin/users/${id(userId)}/${USER_STATE_ACTIONS[action]}`,
      body,
      idempotencyKey,
      group: 'users',
    },
    AdminUserStateResponseSchema,
  );

export const revokeUserSessions = (userId: string, body: AdminReasonBody, idempotencyKey: string) =>
  apiFetch(
    {
      method: 'POST',
      path: `/admin/users/${id(userId)}/sessions/revoke`,
      body,
      idempotencyKey,
      group: 'users',
    },
    AdminUserSessionsRevokeResponseSchema,
  );

export const addUserNote = (userId: string, body: AdminNoteBody, idempotencyKey: string) =>
  apiFetch(
    {
      method: 'POST',
      path: `/admin/users/${id(userId)}/notes`,
      body,
      idempotencyKey,
      group: 'users',
    },
    AdminNoteResponseSchema,
  );

export const adjustWallet = (userId: string, body: AdminAdjustWalletBody, idempotencyKey: string) =>
  apiFetch(
    {
      method: 'POST',
      path: `/admin/users/${id(userId)}/adjust-wallet`,
      body,
      idempotencyKey,
      group: 'users',
    },
    AdminAdjustWalletResponseSchema,
  );

/** What an adjustment would meet now (OWNER): balance after it, code rule, sets to confirm. */
export const getAdjustPreview = (userId: string, amountTiyin: string, signal?: AbortSignal) =>
  apiFetch(
    {
      path: `/admin/users/${id(userId)}/adjust-preview`,
      query: { amountTiyin },
      group: 'users',
      signal,
    },
    AdminAdjustPreviewResponseSchema,
  );
