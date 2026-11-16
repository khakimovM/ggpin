// Admin roles and the admin session's names and timings (phase 9, D-63 (3) and (9)). The API
// issues and checks the session; the SPA only needs the role names. Seconds everywhere, like
// auth-constants.ts.
import { z } from 'zod';
import type { AuthNodeEnv } from '../auth/auth-constants';

/** `AdminUser.role` (Prisma enum AdminRole). OWNER is created by the CLI only (D-63 (6)). */
export const ADMIN_ROLES = ['OWNER', 'OPERATOR', 'SUPPORT'] as const;
export const AdminRoleSchema = z.enum(ADMIN_ROLES);
export type AdminRole = z.infer<typeof AdminRoleSchema>;

/** The roles the panel may give (`POST /admin/admins`, `PATCH /admin/admins/:id`). */
export const PANEL_ASSIGNABLE_ROLES = ['OPERATOR', 'SUPPORT'] as const;
export const PanelAssignableRoleSchema = z.enum(PANEL_ASSIGNABLE_ROLES);
export type PanelAssignableRole = z.infer<typeof PanelAssignableRoleSchema>;

/**
 * Absolute session life: 8 hours from login (`AdminSession.expiresAt`). A constant, not env:
 * a longer admin session is a policy change, not a deployment knob (D-63 (9)).
 */
export const ADMIN_SESSION_TTL_SEC = 28_800;

/** Idle limit: a session not used for 1 hour is dead (`AdminSession.lastUsedAt`). */
export const ADMIN_SESSION_IDLE_SEC = 3_600;

/**
 * Cookie name outside production. Runtime code must not use it directly: ask
 * `adminSessionCookieName(nodeEnv)`. It shares no name with the user cookies (`access_token`,
 * `refresh_token`), so an admin cookie never authenticates a user route and the other way round.
 */
export const ADMIN_SESSION_COOKIE_NAME = 'adm_session';

/**
 * The single source of the admin session cookie name, the `authCookieNames` pattern: only
 * development and test keep the plain name (Safari refuses Secure cookies on http://localhost);
 * every other value, a future `staging` included, gets `__Host-`, which the browser accepts only
 * with Secure, Path=/ and no Domain, so a sibling subdomain cannot plant its own admin session.
 */
export function adminSessionCookieName(nodeEnv: AuthNodeEnv): string {
  if (nodeEnv === 'development' || nodeEnv === 'test') return ADMIN_SESSION_COOKIE_NAME;
  return `__Host-${ADMIN_SESSION_COOKIE_NAME}`;
}
