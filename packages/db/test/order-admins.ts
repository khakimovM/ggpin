import { db } from './client';

// AdminUser rows and ADMIN resolvers for the NEEDS_REVIEW tests. Re-exported by order-fixtures.ts.

let counter = 0;

/** An AdminUser row: the role the resolver of `resolveNeedsReview` is judged by (audit L3). */
export function createAdmin(role: 'OWNER' | 'OPERATOR' | 'SUPPORT' = 'OWNER', isActive = true) {
  return db.adminUser.create({
    data: { telegramId: BigInt(5_000_000 + ++counter), name: `admin-${role}`, role, isActive },
  });
}

/**
 * A resolver of `type: 'ADMIN'` for the AdminUser `id`; the role comes from the database. `role` is
 * accepted only so a test can show that a role the caller claims is ignored (audit L3).
 */
export const adminResolver = (
  id: string,
  overrides: { readonly otpVerified?: boolean; readonly role?: string } = {},
) => ({
  kind: 'operator' as const,
  type: 'ADMIN' as const,
  id,
  ip: '10.0.0.2',
  osUser: null,
  otpVerified: true,
  ...overrides,
});
