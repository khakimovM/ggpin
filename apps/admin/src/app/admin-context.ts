import type { AdminMeResponse } from '@repo/shared';
import { createContext, useContext } from 'react';

/** The signed-in admin, provided by <RequireAdmin> once `GET /admin/auth/me` answered. */
export const AdminContext = createContext<AdminMeResponse | null>(null);

export function useAdmin(): AdminMeResponse {
  const admin = useContext(AdminContext);
  if (admin === null) throw new Error('useAdmin must be used inside <RequireAdmin>');
  return admin;
}
