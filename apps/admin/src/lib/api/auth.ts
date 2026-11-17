// `/admin/auth/*` (docs/04 "Admin" — Auth). Every response is checked against the shared schema.
import {
  AdminLoginStartResponseSchema,
  AdminLoginStatusResponseSchema,
  AdminLoginVerifyResponseSchema,
  AdminLogoutResponseSchema,
  AdminMeResponseSchema,
  type AdminLoginStartResponse,
  type AdminLoginStatusResponse,
  type AdminLoginVerifyResponse,
  type AdminMeResponse,
} from '@repo/shared';
import { apiFetch } from './client';
import { ME_PATH } from './http';

export function startAdminLogin(): Promise<AdminLoginStartResponse> {
  return apiFetch(
    { method: 'POST', path: '/admin/auth/start', body: {}, session: 'none', group: 'auth' },
    AdminLoginStartResponseSchema,
  );
}

export function getAdminLoginStatus(
  nonce: string,
  signal?: AbortSignal,
): Promise<AdminLoginStatusResponse> {
  return apiFetch(
    {
      path: `/admin/auth/status/${encodeURIComponent(nonce)}`,
      session: 'none',
      group: 'auth',
      signal,
    },
    AdminLoginStatusResponseSchema,
  );
}

export function verifyAdminLogin(nonce: string, code: string): Promise<AdminLoginVerifyResponse> {
  return apiFetch(
    {
      method: 'POST',
      path: '/admin/auth/verify',
      body: { nonce, code },
      session: 'none',
      group: 'auth',
    },
    AdminLoginVerifyResponseSchema,
  );
}

/** A 404 here is "not signed in" (D-26): the client reports it as session lost. */
export function getAdminMe(signal?: AbortSignal): Promise<AdminMeResponse> {
  return apiFetch({ path: ME_PATH, group: 'auth', signal }, AdminMeResponseSchema);
}

export async function logoutAdmin(): Promise<void> {
  await apiFetch(
    { method: 'POST', path: '/admin/auth/logout', body: {}, group: 'auth' },
    AdminLogoutResponseSchema,
  );
}
