// Admin management (docs/04 «Adminlar (OWNER)», plan S9b, D-63 (4), (6)): OWNER only, the acting
// OWNER's code on every write. Each carries the registry's Idempotency-Key (the CSRF header is
// added by http.ts); the bodies come from `admin-change-model.ts` and are typed by the shared
// schemas.
import {
  AdminAccountResponseSchema,
  AdminSessionsRevokeResponseSchema,
  type AdminCreateBody,
  type AdminManagementBody,
  type AdminUpdateBody,
} from '@repo/shared';
import { apiFetch } from './client';

const id = (value: string) => encodeURIComponent(value);

export const createAdmin = (body: AdminCreateBody, idempotencyKey: string) =>
  apiFetch(
    { method: 'POST', path: '/admin/admins', body, idempotencyKey, group: 'admins' },
    AdminAccountResponseSchema,
  );

export const updateAdmin = (adminId: string, body: AdminUpdateBody, idempotencyKey: string) =>
  apiFetch(
    {
      method: 'PATCH',
      path: `/admin/admins/${id(adminId)}`,
      body,
      idempotencyKey,
      group: 'admins',
    },
    AdminAccountResponseSchema,
  );

/** Every session of one admin, an OWNER's too (Q7 b: a stolen session is cut fast). */
export const revokeAdminSessions = (
  adminId: string,
  body: AdminManagementBody,
  idempotencyKey: string,
) =>
  apiFetch(
    {
      method: 'POST',
      path: `/admin/admins/${id(adminId)}/sessions/revoke`,
      body,
      idempotencyKey,
      group: 'admins',
    },
    AdminSessionsRevokeResponseSchema,
  );

export const revokeAdminSession = (
  sessionId: string,
  body: AdminManagementBody,
  idempotencyKey: string,
) =>
  apiFetch(
    {
      method: 'POST',
      path: `/admin/sessions/${id(sessionId)}/revoke`,
      body,
      idempotencyKey,
      group: 'admins',
    },
    AdminSessionsRevokeResponseSchema,
  );
